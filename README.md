# 🍯 Nectar

![Nectar Interface](images/screen1.png)

**Nectar** is a lightweight, high-performance P2P file sharing desktop application built on the **Hypercore Protocol** stack. It allows users to seed files and download them using secure 64-character public keys, featuring a modern "glassmorphism" interface.

> [!IMPORTANT]
> **AI-Powered Prototype**: This project is a functional prototype designed and implemented entirely by an **AI Coding Assistant**. It serves as a demonstration of modern P2P technologies and rapid AI-assisted development.

## ✨ Features

- **Decentralized Seeding**: Turn any file into a P2P stream instantly.
- **Isolated Sessions**: Robust `Corestore` management ensuring stability during multi-torrent operations.
- **Real-time Monitoring**: Live peer count tracking via `Hyperswarm` events.
- **Native Experience**: Powered by Electron with native file and directory pickers.
- **Modern UI**: Sleek, dark-mode dashboard with smooth animations.

## 🛠️ Technology Stack

Nectar is built using the following state-of-the-art technologies:

- **[Electron](https://www.electronjs.org/)**: Cross-platform desktop application framework.
- **[Hyperswarm](https://github.com/holepunchto/hyperswarm)**: A distributed networking stack for finding and connecting to peers.
- **[Corestore](https://github.com/holepunchto/corestore)**: Smart storage for multiple Hypercores.
- **[Hyperdrive](https://github.com/holepunchto/hyperdrive)**: A P2P file system built on top of Hypercore.
- **[Hyperbee](https://github.com/holepunchto/hyperbee)**: A B-tree built over Hypercore for efficient metadata indexing.
- **[Pears](https://pears.com/)**: The peer-to-peer app development platform.
- **[Express](https://expressjs.com/)**: Fast, unopinionated, minimalist web framework for the internal API.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [npm](https://www.npmjs.com/)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/vogster/nectar.git
   cd nectar
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the App

Start the application in development mode:
```bash
npm start
```

## 📜 License

ISC License - Feel free to use and modify for your own honey-filled projects! 🍯
