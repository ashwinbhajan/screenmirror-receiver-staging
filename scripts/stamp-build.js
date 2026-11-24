// Stamps one build id into every cache-busting query string so TVs always load
// matching receiver.js / styles.css / assets. RECEIVER_REVISION (what the iPhone
// app accepts) is NOT changed here on purpose.
const fs = require("fs");
const path = require("path");
const build = process.argv[2] || new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const file = path.join(__dirname, "..", "v2", "receiver.html");
let html = fs.readFileSync(file, "utf8");
html = html.replace(/(\.(?:js|css|png)\?[^"']*?)(?:&amp;build=[A-Za-z0-9-]+)?(["'])/g, `$1&amp;build=${build}$2`);
fs.writeFileSync(file, html);
console.log(`stamped build=${build}`);
