// MIBS.GG/src/main.js
import Phaser from 'phaser';
import Play from './scenes/Play.js';
import { initializeNetwork } from './net/configClient.js';

// Initialize network connection and fetch constants
const gameReady = initializeNetwork();

gameReady.then((networkData) => {
  const { constants, socket } = networkData;
  
  // Phaser game configuration
  const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#0a0614',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    physics: {
      default: 'arcade',
      arcade: {
        debug: false
      }
    },
    scene: [Play],
    callbacks: {
      postBoot: function(game) {
        // Inject constants and socket into the game
        game.registry.set('constants', constants);
        game.registry.set('socket', socket);
      }
    }
  };
  
  // Create game instance
  const game = new Phaser.Game(config);
  
  // Handle window resize
  window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
  });
  
  // Expose game globally for debugging
  window.game = game;
  
  console.log('🎮 MIBS.GG Client initialized');
  console.log('📡 Server constants version:', constants.version);
}).catch((error) => {
  console.error('Failed to initialize game:', error);
  
  // Show error to user
  const container = document.getElementById('game-container');
  container.innerHTML = `
    <div style="
      color: #FFD700;
      font-family: 'Poppins', sans-serif;
      text-align: center;
      padding: 40px;
    ">
      <h1 style="font-size: 48px; margin-bottom: 20px;">Connection Error</h1>
      <p style="font-size: 18px; color: #E8D4FF;">
        Unable to connect to game server.<br>
        Please make sure the server is running on ${import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'}
      </p>
      <button 
        onclick="location.reload()" 
        style="
          margin-top: 30px;
          padding: 15px 30px;
          background: linear-gradient(135deg, #6B2FD6, #9D5FFF);
          color: white;
          border: none;
          border-radius: 8px;
          font-family: 'Poppins', sans-serif;
          font-weight: 600;
          font-size: 16px;
          cursor: pointer;
        "
      >
        Retry Connection
      </button>
    </div>
  `;
});