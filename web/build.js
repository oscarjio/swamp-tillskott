// Bygger en webbversion (för felsökning mot riktig data i webbläsaren, inloggad på portal.swamp.se)
const fs = require('fs'), path = require('path');
const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let html = R('src/index.html');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace('<link rel="stylesheet" href="vendor/leaflet.css">', '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>' + R('src/styles.css') + '</style>')
  .replace('<script src="vendor/echarts.min.js"></script>', '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>')
  .replace('<script src="vendor/leaflet.js"></script>', '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>')
  .replace('<script src="analysis.js"></script>', () => '<script>' + R('src/analysis.js') + '</script><script>' + R('web/shim.js') + '</script>')
  .replace('<script src="app.js"></script>', () => '<script>' + R('src/app.js') + '</script>');
fs.writeFileSync(path.join(__dirname, 'debug.html'), html);
