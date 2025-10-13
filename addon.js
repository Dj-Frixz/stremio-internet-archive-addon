const { addonBuilder }  = require('stremio-addon-sdk');

const builder = new addonBuilder({
    id: 'org.stremio.internet-archive',
    version: '0.0.1',
    name: 'Internet Archive',
    description: 'See if a movie is available on Internet Archive and play it instantly, directly from Stremio.',
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
    for (const film of results) {
        const id = film.fields.identifier;
        const metaResponse = await fetch(`https://archive.org/metadata/${id}/files`);
        const files = (await metaResponse.json())?.result || [];
        const subtitles = files
        .filter(f => ACCEPTED_SUBTITLES.includes(f.name.slice(-3).toLowerCase()))
        .map(f => ({id: f.name, url: `https://archive.org/download/${id}/${f.name}`, lang:'en'})); // lang en by default
        streams = streams.concat( // video files
            files
            .filter(f => ACCEPTED_FILE_TYPES.includes(f.name.slice(-3).toLowerCase()))
            .map(f => ({
                url: `https://archive.org/download/${id}/${f.name}`,
                name: `IA ${f.width}p ${f.format}`,
                description: `${film.fields.title}\n${f.name}\n🎬 ${f.name.slice(-3).toLowerCase()} ${f.source}\n🕥 ${(f.length/60).toFixed(0)} min   💾 ${sizeToString(f.size)}`,
                subtitles: subtitles,
                behaviorHints: {
                    notWebReady: f.name.slice(-3).toLowerCase() !== 'mp4', // mp4 is the only web-ready format
                    videoSize: f.size,
                    filename: f.name
                }
            }))
        );
        const maxSize = Math.max(...files.map(f => f.size || 0));
        const maxSizeFile = files.find(f => f.size == maxSize);
        const maxSizeFileRes = maxSizeFile.width || Math.max(...files.map(f => f.width || 0));
        const maxSizeFileType = maxSizeFile.name.slice(-3).toLowerCase();
        streams = streams.concat( // torrents
            files
            .filter(f => f.name.slice(-7)==='torrent')
            .map(f => ({
                infoHash: f.btih, // BitTorrent info hash (probably)
                name: `IA ${maxSizeFileRes!==0 ? maxSizeFileRes+'p' : ''} ${f.format}`,
                description: `${film.fields.title}\n${f.name}\n🎬 ${maxSizeFileType} (archive torrent)\n🕥 ${(maxSizeFile.length/60).toFixed(0)} min   💾 ${sizeToString(maxSize)}`,
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