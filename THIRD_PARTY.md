# Third-party software

The release packages include third-party notices in the `licenses` resources directory. The exact dependency versions and source package URLs are recorded in `package-lock.json` at the release tag.

- [Ableton Link](https://github.com/Ableton/link) is © Ableton AG and distributed under GPL-2.0-or-later. The [Node.js binding](https://github.com/ktamas77/ableton-link) declares MIT in its package metadata. The exact npm source archive shipped alongside each release includes the binding and its vendored Link SDK. The SDK includes Asio under the Boost Software License.
- [@julusian/midi](https://github.com/julusian/node-midi) is MIT licensed and contains RtMidi. Its exact npm package is supplied alongside each release.
- [Electron](https://github.com/electron/electron) is MIT licensed. The Electron distribution includes its own Electron and Chromium license notices. The Electron version is recorded in the lockfile; see [Electron releases](https://github.com/electron/electron/releases) for the runtime source and [Electron build instructions](https://www.electronjs.org/docs/latest/development/build-instructions-gn).
- [QRCode](https://github.com/soldair/node-qrcode) and [Socket.IO Client](https://github.com/socketio/socket.io) are MIT licensed. Notices from their runtime dependencies are included with the release.
