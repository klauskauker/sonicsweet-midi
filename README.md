# SonicSweet MIDI

SonicSweet MIDI verbindet die Webapp [sonicsweet.de](https://sonicsweet.de) per QR-Code mit deiner Musiksoftware. Die Desktop-App wandelt Noten und Performance-Steuerdaten in Standard MIDI oder MPE um. Ableton Link kann Tempo, Phase und Transport zwischen deiner Musiksoftware und SonicSweet synchronisieren.

## Download und Einrichtung

1. Lade unter [Releases](https://github.com/klauskauker/sonicsweet-midi/releases) das ZIP für **macOS Apple Silicon**, **macOS Intel** oder **Windows x64** herunter und entpacke es.
2. **Mac:** Öffne `SonicSweet MIDI.app`. Die App legt den virtuellen CoreMIDI-Port `SonicSweet MIDI` selbst an. Falls Gatekeeper den ersten Start blockiert, folge der [Apple-Anleitung unter „Dennoch öffnen“](https://support.apple.com/de-de/102445).
3. **Windows:** Installiere [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), starte es und lege einen Port namens `SonicSweet MIDI` an. Starte dann `SonicSweet MIDI.exe` aus dem entpackten Ordner und wähle den Port bei Bedarf in der App aus. Windows kann beim ersten Start eine SmartScreen-Meldung anzeigen. Der entpackte Ordner gehört zur App.
4. Öffne auf deinem Mobilgerät SonicSweet und scanne unter **Settings → Connections → Scan QR** den Code der Desktop-App.
5. Wähle `SonicSweet MIDI` in deiner DAW als MIDI-Eingang.

Mehrere Geräte können gleichzeitig verbunden werden. Ein einmal gekoppeltes Gerät verbindet sich automatisch wieder, bis du es über **Gerät vergessen** entfernst. Standard MIDI verwendet den pro Gerät ausgewählten Kanal. MPE verwendet für alle Geräte gemeinsam die Kanäle 2–16 und einen Pitch-Bend-Bereich von ±48 Halbtönen. Aktiviere MPE auch in der DAW und im Instrument.

Für die Zuordnung der Fader, Trigger und XY-Achsen aus dem Performance Controller aktiviere in Ableton Live am MIDI-Eingang zusätzlich **Remote**.

## Ableton Link

Aktiviere den Schalter **Ableton Link** in der Desktop-App und Link in deiner Musiksoftware. Beide laufen im selben lokalen Netzwerk. Für den gemeinsamen Transport aktiviere **Transport folgen** in der Desktop-App und **Start Stop Sync** in Live. Der globale und der gerätespezifische Offset addieren sich. Negative Werte verschieben die Wiedergabe in SonicSweet nach vorne, positive nach hinten.

## Entwicklung

Installiere Node.js 22 und npm. Für das native Link-Modul brauchst du unter macOS die Xcode Command Line Tools, unter Windows Visual Studio mit „Desktopentwicklung mit C++“ und Python.

```sh
npm ci
npm test
npm run check:native
npm start
```

Die App verwendet standardmäßig sonicsweet.de. Über die Server-Einstellungen oder `SONICSWEET_SERVER_URL` lässt sich ein anderer SonicSweet-Server auswählen.

Mit `npm run dist:mac` beziehungsweise `npm run dist:win` baust du ein ZIP auf dem jeweiligen Zielsystem. GitHub Actions baut die veröffentlichten Pakete auf den jeweiligen Plattformen. macOS-Releases sind ad hoc signiert und tragen keine Apple Developer ID oder Notarisierung. Windows-Releases sind ohne Herausgebersignatur.

## Lizenz und Quellcode

SonicSweet MIDI steht unter **GPL-3.0-or-later**. Der entsprechende App-Quellcode samt Build-Anleitung und Lockdatei befindet sich beim jeweiligen Git-Tag. Releases stellen zusätzlich die verwendeten nativen npm-Quellpakete bereit. Details stehen in [THIRD_PARTY.md](THIRD_PARTY.md).
