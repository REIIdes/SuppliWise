const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Create SVG string for the SuppliWise logo
const createSvg = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" rx="22" fill="#3dbf8a"/>
  <g transform="rotate(-40, 50, 50)">
    <rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="white" stroke-width="6"/>
    <line x1="50" y1="36" x2="50" y2="64" stroke="white" stroke-width="6"/>
  </g>
</svg>
`;

// Icon sizes for different Android densities
const iconSizes = [
  { size: 48, folder: 'mipmap-mdpi' },
  { size: 72, folder: 'mipmap-hdpi' },
  { size: 96, folder: 'mipmap-xhdpi' },
  { size: 144, folder: 'mipmap-xxhdpi' },
  { size: 192, folder: 'mipmap-xxxhdpi' },
];

const iconNames = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];

async function generateIcons() {
  console.log('🎨 Generating SuppliWise Android icons...\n');

  for (const { size, folder } of iconSizes) {
    const folderPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', folder);
    
    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const svgBuffer = Buffer.from(createSvg(size));

    for (const iconName of iconNames) {
      const outputPath = path.join(folderPath, iconName);
      
      try {
        await sharp(svgBuffer)
          .resize(size, size)
          .png()
          .toFile(outputPath);
        
        console.log(`✅ Generated: ${folder}/${iconName} (${size}x${size})`);
      } catch (error) {
        console.error(`❌ Error generating ${folder}/${iconName}:`, error.message);
      }
    }
  }

  // Also generate web PWA icons
  console.log('\n🌐 Generating PWA icons...\n');
  
  const pwaIcons = [
    { size: 192, name: 'pwa-192x192.png' },
    { size: 512, name: 'pwa-512x512.png' },
    { size: 180, name: 'apple-touch-icon.png' },
  ];

  const publicPath = path.join(__dirname, 'public');

  for (const { size, name } of pwaIcons) {
    const svgBuffer = Buffer.from(createSvg(size));
    const outputPath = path.join(publicPath, name);

    try {
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(outputPath);
      
      console.log(`✅ Generated: public/${name} (${size}x${size})`);
    } catch (error) {
      console.error(`❌ Error generating ${name}:`, error.message);
    }
  }

  console.log('\n🎉 All icons generated successfully!');
}

generateIcons().catch(console.error);
