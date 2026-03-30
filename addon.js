const { addonBuilder } = require("stremio-addon-sdk")
const axios = require("axios")
const cheerio = require("cheerio")

const builder = new addonBuilder({
  id: "allmovieland.pro",
  version: "1.0.0",
  name: "AllMovieLand PRO",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [] // 🔥 IMPORTANT FIX
})

let sessionCookie = null

// 🔥 SESSION (same as Kotlin ensureSession)
async function ensureSession() {
  if (!sessionCookie) {
    const res = await axios.get("https://allmovieland.you/")
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


// 🔥 SEARCH API
async function searchMovie(query) {
  const cookie = await ensureSession()

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


// 🔥 EXTRACT PLAYER + TOKEN
async function extractPayload(pageUrl) {
  const cookie = await ensureSession()

  const pageRes = await axios.get(pageUrl, {
    headers: { "Cookie": cookie }
  })

  const page = pageRes.data

  const domainMatch = page.match(/AwsIndStreamDomain.*'(.*?)'/)
  const idMatch = page.match(/play\/(.*?)['"]/)

  if (!domainMatch || !idMatch) return null

  const playerDomain = domainMatch[1]
  const videoId = idMatch[1]

  const embedUrl = `${playerDomain}/play/${videoId}`

  const embedRes = await axios.get(embedUrl, {
    headers: { "Cookie": cookie }
  })

  const jsonMatch = embedRes.data.match(/\{.*\}/s)
  if (!jsonMatch) return null

  const json = JSON.parse(jsonMatch[0])

  const token = json.key
  const fileApi = json.file.startsWith("http")
    ? json.file
    : playerDomain + json.file

  const fileRes = await axios.post(fileApi, {}, {
    headers: {
      "X-CSRF-TOKEN": token,
      "User-Agent": "Mozilla/5.0",
      "Referer": embedUrl
    }
  })

  const files = JSON.parse(fileRes.data)

  return { playerDomain, token, files }
}


// 🔥 FINAL M3U8
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

    return res.data
  } catch (e) {
    return null
  }
}


// 🔥 MAIN HANDLER
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

    // STEP 1: SEARCH
    const pageUrl = await searchMovie(imdb)
    if (!pageUrl) return { streams: [] }

    // STEP 2: EXTRACT PAYLOAD
    const payload = await extractPayload(pageUrl)
    if (!payload) return { streams: [] }

    const { playerDomain, token, files } = payload

    let streams = []

    for (let f of files) {
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
