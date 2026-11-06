const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
async function main() {
  const svg = await fs.readFile(path.join(__dirname, '../workbench/assets/tideflow-mark.svg'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(size => sharp(svg).resize(size, size).png().toBuffer()));
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const start = 6 + index * 16, size = sizes[index];
    directory[start] = size === 256 ? 0 : size; directory[start + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, start + 4); directory.writeUInt16LE(32, start + 6);
    directory.writeUInt32LE(image.length, start + 8); directory.writeUInt32LE(offset, start + 12); offset += image.length;
  });
  await fs.mkdir(path.join(__dirname, 'assets'), { recursive: true });
  await fs.writeFile(path.join(__dirname, 'assets/tideflow.ico'), Buffer.concat([directory, ...images]));
  await fs.writeFile(path.join(__dirname, 'assets/tideflow.png'), images.at(-1));
  console.log('Tideflow PNG and multi-resolution ICO generated from official SVG.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
