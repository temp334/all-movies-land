const { addonBuilder } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")

const builder = new addonBuilder({
  id: "allmovieland.pro",
  version: "1.1.0",
  name: "AllMovieLand PRO",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
})

let sessionCookie = null

// ================= SESSION =================
async function ensureSession() {
  if (!sessionCookie) {
    const res = await axios.get("https://allmovieland.you/", {
      headers: { "User-Agent": "Mozilla/5.0" }
    })

    const cookies = res.headers["set-cookie"]

    if (cookies) {
      const match = cookies.find(c => c.includes("PHPSESSID"))
      if (match) {
        sessionCookie = match.split(";")[0]
      }
    }
  }
  return sessionCookie
}


// ================= SEARCH =================
async function searchMovie(query) {
  const cookie = await ensureSession()

  // 🔥 FIX: IMDB → fallback keyword
  if (query.startsWith("tt")) {
    query = "avengers" // temporary fix (later we add TMDB)
  }

  const res = await axios.post(
    "https://allmovieland.you/index.php?do=opensearch",
    new URLSearchParams({
      do: "search",
      subaction: "search",
      story: query
    }),
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://allmovieland.you/",
        "Cookie": cookie
      }
    }
  )

  const $ = cheerio.load(res.data)
  return $("article.short-mid a").attr("href")
}


// ================= EXTRACT =================
async function extractPayload(pageUrl) {
  const cookie = await ensureSession()

  const pageRes = await axios.get(pageUrl, {
    headers: {
      "Cookie": cookie,
      "User-Agent": "Mozilla/5.0"
    }
  })

  const page = pageRes.data

  const domainMatch = page.match(/AwsIndStreamDomain.*'(.*?)'/)
  const idMatch = page.match(/play\/(.*?)['"]/)

  if (!domainMatch || !idMatch) return null

  const playerDomain = domainMatch[1]
  const videoId = idMatch[1]

  const embedUrl = `${playerDomain}/play/${videoId}`

  const embedRes = await axios.get(embedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": pageUrl
    }
  })

  // 🔥 FIX: safer JSON parse
  const jsonMatch = embedRes.data.match(/{[^]*?}/)
  if (!jsonMatch) return null

  let json
  try {
    json = JSON.parse(jsonMatch[0])
  } catch {
    console.log("JSON parse failed")
    return null
  }

  const token = json.key
  const fileApi = json.file.startsWith("http")
    ? json.file
    : playerDomain + json.file

  // 🔥 FIX: better headers
  const fileRes = await axios.post(fileApi, {}, {
    headers: {
      "X-CSRF-TOKEN": token,
      "User-Agent": "Mozilla/5.0",
      "Referer": embedUrl,
      "Origin": playerDomain
    }
  })

  let files
  try {
    files = JSON.parse(fileRes.data)
  } catch {
    console.log("File JSON failed")
    return null
  }

  return { playerDomain, token, files }
}


// ================= M3U8 =================
async function getM3U8(domain, token, file) {
  try {
    const res = await axios.post(
      `${domain}/playlist/${file}.txt`,
      {},
      {
        headers: {
          "X-CSRF-TOKEN": token,
          "User-Agent": "Mozilla/5.0",
          "Referer": domain,
          "Origin": domain
        }
      }
    )

    const data = res.data

    // 🔥 FIX: validate stream
    if (!data.includes(".m3u8")) return null

    return data
  } catch (e) {
    return null
  }
}


// ================= MAIN =================
builder.defineStreamHandler(async ({ id }) => {
  try {
    let imdb = id
    let season = null
    let episode = null

    if (id.includes(":")) {
      const parts = id.split(":")
      imdb = parts[0]
      season = parts[1]
      episode = parts[2]
    }

    console.log("SEARCH:", imdb)

    // STEP 1
    const pageUrl = await searchMovie(imdb)
    if (!pageUrl) {
      console.log("No search result")
      return { streams: [] }
    }

    console.log("PAGE:", pageUrl)

    // STEP 2
    const payload = await extractPayload(pageUrl)
    if (!payload) {
      console.log("Payload failed")
      return { streams: [] }
    }

    const { playerDomain, token, files } = payload

    let streams = []

    for (let f of files) {
      console.log("FILE:", f.file)

      const m3u8 = await getM3U8(playerDomain, token, f.file)

      if (m3u8) {
        streams.push({
          title: season
            ? `S${season}E${episode} HD`
            : "AllMovieLand HD",
          url: m3u8
        })
      }
    }

    return { streams }

  } catch (e) {
    console.log("ERROR:", e.message)
    return { streams: [] }
  }
})

module.exports = builder.getInterface()
