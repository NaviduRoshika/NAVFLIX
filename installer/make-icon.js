// Builds navflix.ico from the PNG icons the web app already has.
//
// An .ico file is a short directory followed by the images it lists, and since
// Windows Vista those images may simply be PNG files, so no image library is
// needed. Each PNG's real size is read from its own header rather than assumed.
//
//   node installer/make-icon.js <public folder> <out.ico>
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCES = ['favicon-32.png', 'icon-192.png', 'icon-512.png'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeIcon(publicDir, out) {
  const images = [];
  for (const name of SOURCES) {
    const file = path.join(publicDir, name);
    if (!fs.existsSync(file)) continue;
    const png = fs.readFileSync(file);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(name + ' is not a PNG');
    // IHDR is always the first chunk: width and height sit at bytes 16 and 20.
    images.push({ png: png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  }
  if (!images.length) throw new Error('No icon PNGs found in ' + publicDir);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);             // reserved
  header.writeUInt16LE(1, 2);             // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    // One byte each; 0 means 256 or more.
    e.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    e.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    e.writeUInt8(0, 2);                   // no palette
    e.writeUInt8(0, 3);                   // reserved
    e.writeUInt16LE(1, 4);                // colour planes
    e.writeUInt16LE(32, 6);               // bits per pixel
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.png.length;
    return e;
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([header].concat(entries, images.map((i) => i.png))));
  return images.map((i) => i.width + 'x' + i.height);
}

module.exports = makeIcon;

if (require.main === module) {
  const sizes = makeIcon(process.argv[2], process.argv[3]);
  console.log('icon with ' + sizes.join(', ') + ' -> ' + process.argv[3]);
}
