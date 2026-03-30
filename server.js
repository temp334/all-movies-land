const addonInterface = require("./addon")
const { serveHTTP } = require("stremio-addon-sdk")

const port = process.env.PORT || 7000
serveHTTP(addonInterface, { port })
