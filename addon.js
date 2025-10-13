const { addonBuilder }  = require('stremio-addon-sdk');
const pkg = require('./package');

const builder = new addonBuilder({
    id: 'org.stremio.internet-archive',
    version: pkg.version,
    name: 'Internet Archive',
    description: pkg.description,
    catalogs: [], // { type: 'movie', id: 'ia', name: 'Internet Archive' }
    resources: ['stream'],
    types: ['movie'],
    idPrefixes: ['tt'],
});

const ACCEPTED_FILE_TYPES = ['avi', 'mp4', 'mkv', 'wmv', 'mov', 'm4v'];
const ACCEPTED_SUBTITLES = ['srt', 'vtt', 'ass'];
const MAX_STREAMS = 5;
const sizeToString = bytes => bytes >= 1073741824 ? `${(bytes/1073741824).toFixed(1)}GB` : `${(bytes/1048576).toFixed(0)}MB`;

async function fetchStreams(id) {
    const imdbId = id;
    const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`;
    const cinemetaResponse = await fetch(cinemetaUrl);
    if (!cinemetaResponse.ok) {
        return { streams: [] };
    }
    const film = (await cinemetaResponse.json())?.meta;
    if (!film) {
        return { streams: [] };
    }
    const runtime = parseInt(film.runtime.slice(0,-4)) * 60; // typical runtime (in seconds)
    const director_surname = (film.director?.[0] || '').split(' ').slice(-1)[0];
    const year = film.year * 1; // cast to int
    const queryParts = [
        `(${director_surname} OR ${year} OR ${year-1} OR ${year+1})`, // director's surname or year (±1)
        `title:(${film.name.toLowerCase()})`, // title (lowercase to avoid known ia bug with "TO" in title)
        '-title:trailer', // exclude trailers
        'mediatype:movies', // movies only
        'item_size:["300000000" TO "100000000000"]' // size between ~300MB and ~100GB
    ];
    const iaUrl = `https://archive.org/services/search/beta/page_production/?user_query=${encodeURIComponent(queryParts.join(' AND '))}&hits_per_page=${MAX_STREAMS}`;
    const iaResponse = await fetch(iaUrl);
    if (!iaResponse.ok) {
        return { streams: [] };
    }
    const iaData = await iaResponse.json();
    const results = iaData?.response?.body?.hits?.hits || [];
    console.log(`Found ${results.length} results on IA for ${film.name} (${imdbId})`);
    let streams = [];
    let counter = 0;
    for (const res of results) {
        const id = res.fields.identifier;
        const metaResponse = await fetch(`https://archive.org/metadata/${id}/files`);
        const files = (await metaResponse.json())?.result || [];
        const subtitles = files
            .filter(f => ACCEPTED_SUBTITLES.includes(f.name.slice(-3).toLowerCase()) && f.length < runtime*0.7)  // skip if it is too short and likely not the full movie
            .map(f => ({id: f.name, url: `https://archive.org/download/${id}/${f.name}`, lang:'en'})); // lang en by default
        const videoFiles = files.filter(f => ACCEPTED_FILE_TYPES.includes(f.name.slice(-3).toLowerCase()));
        if (videoFiles.length === 0) {
            console.log(` - ${id} has no acceptable video files, skipping`);
            continue;
        }
        const quality = (res.fields.title+videoFiles[0].name+(res.fields.description||'')).match(/(?:dvd|blu-?ray|bd|hd|web|nd-?rip)-?(?:rip|dl)?|remux/i)?.[0] || '';
        streams = streams.concat( // video files
            videoFiles.map(f => ({
                url: `https://archive.org/download/${id}/${f.name}`,
                name: `Archive.org ${quality} ${f.height}p ${f.format}`,
                description: `${res.fields.title}\n${f.name}\n🎬 ${f.name.slice(-3).toLowerCase()} (${f.source})\n🕥 ${(f.length/60).toFixed(0)} min   💾 ${sizeToString(f.size)}`,
                subtitles: subtitles,
                behaviorHints: {
                    notWebReady: f.name.slice(-3).toLowerCase() !== 'mp4', // mp4 is the only web-ready format
                    videoSize: parseInt(f.size) || 0,
                    filename: f.name
                }
            }))
        );
        const maxSize = Math.max(...videoFiles.map(f => f.size || 0));
        const maxSizeFile = videoFiles.find(f => f.size == maxSize);
        const maxSizeFileRes = maxSizeFile.height || Math.max(...videoFiles.map(f => f.height || 0));
        const maxSizeFileType = maxSizeFile.name.slice(-3).toLowerCase();
        streams = streams.concat( // torrents
            files
            .filter(f => f.name.slice(-7)==='torrent')
            .map(f => ({
                infoHash: f.btih, // BitTorrent info hash (probably)
                name: `Archive.org ${quality} ${maxSizeFileRes!==0 ? maxSizeFileRes+'p' : ''} ${f.format}`,
                description: `${res.fields.title}\n${f.name}\n🎬 ${maxSizeFileType} (archive torrent)\n🕥 ${(maxSizeFile.length/60).toFixed(0)} min   💾 ${sizeToString(maxSize)}`,
                subtitles: subtitles,
                behaviorHints: { // use the largest file as reference
                    videoSize: maxSize,
                    filename: files.find(f => f.size == maxSize)?.name
                }
            }))
        );
        console.log(` - ${id} (${streams.length - counter} streams)`);
        counter = streams.length;
    }
    console.log(` -> Returning ${streams.length} streams`);
    // console.log(streams); // used for debugging
    return { streams: streams }
}

builder.defineStreamHandler(function ({type, id}) {
    switch(type) {
        case 'movie':
            return fetchStreams(id); // return a promise
        default:
            return Promise.resolve([]); // return a promise
    }
});

module.exports = builder.getInterface();