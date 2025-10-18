import MainMenu from './src/scenes/MainMenu.js';
import Play from './src/scenes/Play.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  backgroundColor: '#0e0720',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: [MainMenu, Play],
};

new Phaser.Game(config);