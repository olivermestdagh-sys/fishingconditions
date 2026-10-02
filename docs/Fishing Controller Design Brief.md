# Fishing Controller: Design Brief

Oct 2, 2026 · @Oliver

A waterproof handheld Bluetooth controller lets Oliver log kayak fishing trips, actions and catches without touching his phone. This brief tells Claude CLI what to build, in what order, and how to set up the tools on Oliver's computer.

## Purpose and scope

The controller is an ESP32 board with a small colour screen, one knob and two buttons. A native Android app holds the Bluetooth link, records GPS and queues data offline, then syncs to the existing Cloudflare D1 database behind the fishing conditions website.

- In scope: bench-prototype firmware, the Bluetooth protocol, the Android app, Worker and D1 additions, and toolchain setup.
- Out of scope for now: iPhone support, Wi-Fi on the controller, the waterproof enclosure, website UI changes.
- Read the whole brief before coding. Work one milestone at a time (section 4). Ask the questions in section 11 when they become relevant. Anything marked *unverified* must be checked against DFRobot's pinout or datasheet before you rely on it.

| Component | Job | Talks to |
| --- | --- | --- |
| Controller (ESP32 firmware) | Screen, knob and buttons, local event log, cached lists | Phone, over Bluetooth Low Energy |
| Android app | Bluetooth link, time sync, GPS track, offline queue, conditions snapshot | Controller (BLE), Worker (HTTPS) |
| Cloudflare Worker and D1 | Validate, store and serve trips, actions, catches | App, website |
| Fishing conditions website | Later: show catches next to conditions | Worker |

## Hardware and pin plan

The bench kit runs from USB with no battery. All logic is 3.3 V.

| Part | Notes |
| --- | --- |
| FireBeetle 2 ESP32-E N16R2 (DFR1139) | ESP32-WROOM-32E, 16 MB flash, 2 MB PSRAM, BLE 4.2, USB-C with CH340, onboard LiPo charger, PH2.0 battery socket, GDI display port |
| DFRobot 2.0" IPS TFT (DFR0664) | 320x240, ST7789V, SPI, no touch. Connects by the included 18-pin flat cable into the board's GDI port, or by pin headers. Backlight pin BL: documented as high = full brightness, low = off |
| Encoder module with button (Core CE09436) | Bench only. Signals A, B and a push switch. Final knob design is undecided |
| Two pushbuttons (not yet bought) | YES/NEXT and BACK/CANCEL |
| BH1750 light sensor (SEN0097) | I2C, for auto-brightness |
| Gravity vibration motor module (DFR0440) | Haptic feedback, one signal pin |
| Adafruit USB-C power analyzer (ADA6271) | Inline between charger and board, for measuring current |
| Battery | None yet. Buy after measuring. Expect a 1S LiPo of 2000-3000 mAh with protection and a PH2.0 plug. Check polarity with a multimeter against the board's markings before connecting |

### Verified from DFRobot documentation

- DFRobot's GDI example for this board uses Arduino labels D2 = DC, D6 = CS, D3 = RST, D13 = BL.
- D6 = GPIO14, D13 = GPIO12, D7 = GPIO13, D4 = GPIO27 (the onboard user button), D8 = GPIO5 (RGB LED), D9 = GPIO2 (onboard LED).
- Default SPI pins: SCK GPIO18, MISO GPIO19, MOSI GPIO23. I2C: SDA GPIO21, SCL GPIO22.
- GPIO0, 1 and 3 are used by USB and serial. GPIO16 is NC. GPIO34-39 are input-only.
- A solder jumper cuts about 500 uA of static drain; DFRobot quotes 13 uA in deep sleep once it is cut. With it cut, the RGB LED only works on USB power.

### Unverified, check first

- The GPIO numbers behind D2 and D3 (believed to be 25 and 26, read from the pinout diagram).
- The microSD chip-select pin (believed D7 = GPIO13). The SD slot is unused, so GPIO13 may be free.
- Whether the board arrives with header pins fitted.
- Whether PWM on the BL pin gives smooth dimming.
- The polarity of the onboard button on GPIO27 (probably active-low).

Use raw GPIO numbers in code, not D-labels. The labels exist only in DFRobot's Arduino board package.

### Provisional pin allocation

| Signal | Pin | Reason |
| --- | --- | --- |
| Display DC, CS, RST, BL | via GDI cable | Fixed by the cable. Display SPI uses GPIO18 and GPIO23 |
| YES/NEXT | GPIO27 | Wake-capable. The onboard button allows testing before wiring |
| BACK/CANCEL | GPIO4 | Wake-capable |
| Encoder A | GPIO15 | Any pin works. GPIO15 is a strapping pin, so add no external pull-up |
| Encoder B | GPIO17 | Any pin works |
| Vibration motor | GPIO13 | Output |
| Battery voltage | GPIO35 through a resistor divider | No dedicated pin found. A MAX17048 fuel gauge over I2C is an alternative |
| BH1750 | GPIO21 (SDA), GPIO22 (SCL) | Default I2C |

## Setting up Oliver's computer

Oliver has nothing installed for ESP32 or Android work. Claude CLI should install and verify each tool with him, step by step. Assume Windows (his work is in the Microsoft ecosystem) but confirm the operating system first.

### Rules for the setup

- Say what each tool is and why it's needed before installing it, and ask before installing anything.
- Use a package manager (winget on Windows) where Oliver agrees. A graphical installer cannot be driven from the CLI, so walk him through it screen by screen.
- After each install, run a check command and show him the output. Do not move on until it passes.
- Record every installed tool, version and command in the project's `CLAUDE.md`.

### Firmware toolchain

1. Git and VS Code. Check with `git --version`.
2. PlatformIO (VS Code extension) with the Arduino framework. It lets Claude CLI build and flash from the command line. Use the generic `esp32dev` board definition with raw GPIO numbers, since DFRobot's D-labels do not exist there. Arduino IDE 2 is the fallback if PlatformIO gives trouble.
3. The CH340 USB driver, only if Windows does not recognise the board. DFRobot supplies one.
4. Candidate libraries (verify current versions before pinning): NimBLE-Arduino for Bluetooth; DFRobot\_GDL or LovyanGFX for the ST7789 display on the GDI pins; ESP32Encoder or a small interrupt handler; BH1750; ArduinoJson. LVGL is optional.
5. Check: build and flash a blink sketch, then print a line to the serial monitor.

### Android toolchain

1. Android Studio. It bundles the Android SDK, the JDK and Gradle.
2. Kotlin with Jetpack Compose for the app.
3. Oliver's real phone is required for testing, because Bluetooth does not work in the emulator. On the phone: enable Developer options, then USB debugging (or wireless debugging). Install the phone maker's USB driver if Windows needs it.
4. Install the nRF Connect for Mobile app from the Play Store. It is used to test the Bluetooth service before the Android app exists.
5. Check: `adb devices` lists the phone, and a Hello World app installs and runs on it.

### Cloud toolchain

1. Node.js, then Cloudflare's `wrangler` tool (via `npx wrangler`).
2. `wrangler login` opens a browser for Oliver to authorise. Check with `wrangler whoami` and `wrangler d1 list`.
3. Find how the existing website uses D1 before changing anything: the Worker code, the wrangler configuration, the schema and the auth method.
4. Never commit API tokens. Use Worker secrets and the Android encrypted preferences.

### Repository layout

Create a new repository, for example `fishing-controller`, with `firmware/`, `android/`, `worker/` (or reuse the website's Worker location, see section 9) and `docs/`. Put this brief in `docs/` and a short `CLAUDE.md` at the root. Do not edit the website repository (`olivermestdagh-sys/fishingconditions`) unless Oliver asks.

## Build order and milestones

Build in this order. Each milestone has a pass test that Oliver can see for himself; do not start the next one until it passes.

1. **M0 Tools.** Section 3 complete. Pass: a blink sketch flashes, serial prints, `adb devices` shows the phone, `wrangler whoami` works.
2. **M1 Display.** The screen shows text over the GDI cable. Pass: "Hello" is readable in landscape at 320x240, and the backlight can be turned off.
3. **M2 Inputs and menus, no Bluetooth.** Knob and two buttons drive a menu on screen using hard-coded lists. Pass: a full simulated catch flow can be completed with the knob and buttons alone.
4. **M3 Bluetooth proof.** The controller advertises and exposes the service in section 6. Pass: using nRF Connect, Oliver can write the time, write a list, receive a catch event and acknowledge it.
5. **M4 Android link.** The app connects, stays connected with the screen off (foreground service), syncs time and config, and receives events into a local database. Pass: log five catches with the phone locked, then see all five in the app.
6. **M5 Cloud sync.** The app uploads queued events to D1 through the Worker, safely repeatable. Pass: a catch made offline appears in D1 once, after the phone regains signal, even if the upload is retried.
7. **M6 Full flows.** Trips, actions and catches with GPS tags and a conditions snapshot, plus editing in the app. Pass: a mock four-hour trip end to end.
8. **M7 Power.** Measure current in each state (section 10) and choose the battery. Pass: a measured table and a battery recommendation.
9. **M8 Later.** Battery gauge, over-the-air updates, website display of catches, enclosure.

## Firmware requirements

The controller must work fully without the phone, never lose a logged event, and be usable with wet or gloved hands.

### Controls

- Knob rotation changes the highlighted item or value. For number entry (fish length) it accelerates when turned fast.
- YES/NEXT confirms and moves forward. BACK/CANCEL steps back. Holding BACK for about one second cancels the whole flow.
- Debounce all inputs. Keep the main loop non-blocking: separate tasks for input, display and Bluetooth.

### Screens

1. Boot, then Pairing (shows a six-digit number to compare with the phone, answered with YES or BACK).
2. Idle with no trip: battery, Bluetooth status, "Start trip".
3. Trip active: elapsed time, current action, catch count, battery, Bluetooth status.
4. Action picker: select and start an action; starting a new one ends the previous.
5. Catch flow: species, size, keep or release, depth, rod, confirm.
6. Settings: brightness mode, vibration on or off, night theme.
7. Error and low-battery messages.

### Catch flow

- Order: species, size (cm), keep or release, depth, rod, confirm.
- Prefill from the last catch (depth and rod). Show recently used species first. A typical catch should take about three presses.
- A "void last event" option, reachable for the rest of the trip, sends a void event and does not delete anything.

### Display

- Landscape 320x240 with large values. Dark theme by default and a red night theme.
- Brightness follows the BH1750 with hysteresis. Use PWM on the BL pin if testing confirms it works.
- Dim after an idle period and turn off after a longer one; any button wakes it.

### Storage and time

- Keep cached lists with their version, the device id, the event sequence counter, bonding keys and an event log in flash. Write each event to flash before showing confirmation.
- The log is a ring buffer holding at least 1000 events. Drop the oldest only after it has been acknowledged by the phone.
- The phone sets the time on every connection. Each event carries device epoch seconds, a monotonic millisecond count and a flag saying whether the time had been synced.

### Power

- Stay connected over Bluetooth with light sleep and a relaxed connection interval (a few hundred milliseconds is acceptable).
- Deep sleep when there is no trip and the device has been idle for several minutes; wake on YES. Deep sleep drops the Bluetooth link, so never use it during a trip.
- Warn at 20 percent and 10 percent battery. Read the battery by divider or fuel gauge (section 2).

### Haptics and robustness

- Short tick per knob step, double pulse on confirm, long pulse on error or disconnect.
- Enable the watchdog. If the phone is absent, the UI keeps working from cached lists and the event log keeps filling.
- Over-the-air updates are a later milestone.

## Bluetooth protocol

The controller is a Bluetooth Low Energy peripheral running a custom GATT service; the phone is the central. It does not pretend to be a keyboard. Events are delivered at least once, in order, and are never lost if the phone is away.

### Connection and security

- Advertise a recognisable name such as `FishCtl-xxxx` while disconnected.
- Pair with LE Secure Connections and Numeric Comparison. The controller has a screen and two buttons, so it can show a six-digit number and take YES or BACK. Bond once; afterwards accept only the bonded phone.
- Request the largest MTU the phone allows (about 185 to 247 bytes). Chunk any message that does not fit.
- The phone reconnects automatically with backoff.

### Service layout

Generate one 128-bit service UUID and one UUID per characteristic when building, and record them in `CLAUDE.md`. Also expose the standard Battery Service for the battery level.

| Characteristic | Properties | Direction | Purpose |
| --- | --- | --- | --- |
| device\_info | read | controller to phone | Protocol version, firmware version, device id, config version held |
| time\_sync | write | phone to controller | Epoch time and timezone offset, sent on every connect |
| config\_in | write, chunked | phone to controller | Lists and dials with a version number |
| config\_state | read, notify | controller to phone | Applied config version; flag asking for a fresh config |
| event\_out | notify | controller to phone | Events, each with a sequence number |
| event\_ack | write | phone to controller | Highest sequence number the phone has saved |
| control | write, notify | both ways | Trip and action state, void, ping |

### Reliability rules

- Every event has a device id and a sequence number that only increases.
- The controller keeps events until acknowledged. On reconnect it replays every unacknowledged event in order.
- The phone saves an event to its local database before acknowledging, and ignores duplicates.
- Send one frame at a time; wait for the transmit to complete before the next, so notifications are not dropped.
- Messages are JSON in UTF-8 during development, wrapped in a small chunk header (message id, chunk index, last-chunk flag). Moving to a compact binary format later is allowed if the size matters.

### Testing

Milestone M3 is tested entirely with nRF Connect, before any Android app code exists.

## Event and config data

Lists are defined on the phone and pushed to the controller, so the choices are never hard-coded in firmware. Every list item has a stable integer id from the database, so renaming a species never breaks history. Units are metric: centimetres and metres.

### Config sent to the controller

| Field | Contents |
| --- | --- |
| config\_version | Integer that rises on every change. The controller reports the version it holds so the phone only resends when they differ |
| species | List of id, name and short name |
| rods | List of id and name (rod and reel combinations) |
| depths | List of values in metres |
| trip\_types | List of id and name |
| actions | List of id and name, for example drifting or anchored (Oliver to define, see section 11) |
| size dial | Minimum, maximum, step and default length in cm |

The example from Oliver: a dial called Distance with the values 5, 8, 10, 12 and 15 m. Dials are generic named lists, so new ones need no firmware change.

### Events sent by the controller

Every event carries: sequence number, type, device epoch seconds, monotonic milliseconds and a time-synced flag.

| Type | Extra fields |
| --- | --- |
| trip\_start | trip type id |
| trip\_end | none |
| action\_start | action id |
| action\_end | none |
| catch | species id, size in cm, fate (keep or release), depth in m, rod id |
| void | sequence number of the event being cancelled |

### Added by the phone before saving

- Latitude, longitude and accuracy from the GPS track at the event time (nearest track point).
- A snapshot of the website's conditions for the nearest tracked location (wind, tide, pressure and the Location and Fishing scores), taken at the time of the catch. The site's published data only keeps about 30 hours of history, so this must be recorded when the catch happens.
- The phone's own timestamp and the device id.

### Times

Store UTC epoch seconds plus the timezone offset. The website uses "naive" local wall-clock times with no timezone conversion, so check its existing convention (`parseNaive`, `naive_to_ms`) and provide a clear conversion rather than mixing the two.

## Android app

The app must keep working with the phone locked in a dry bag, and must never lose a catch. Local storage comes first; uploading is a background job.

### Stack and distribution

- Kotlin and Jetpack Compose. Match the minimum Android version to Oliver's phone.
- A local Room database as the source of truth, and WorkManager for upload retries.
- Install by sideloading the debug build with `adb`. No Play Store release is needed.

### Background operation

- A foreground service with a visible notification holds the Bluetooth connection during a trip. Declare the correct foreground service types (connected device and location) and request the notification permission on Android 13 and above.
- Request Bluetooth scan and connect permissions (Android 12 and above) and fine location. Guide Oliver through turning off battery optimisation for the app.
- Record a GPS track during an active trip every 15 to 30 seconds, using less power when the phone is stationary.

### Screens

1. Connection and pairing status.
2. Trips list and trip detail (map optional, later).
3. Catch log, with editing of species, size and fate after the fact. Edits sync to the database.
4. Lists editor for species, rods, depths, actions and trip types. Changes bump the config version and are pushed to the controller on next connect.
5. Sync status and settings (Worker address and API token).

### Sync behaviour

- Acknowledge events to the controller only after saving locally.
- Upload in batches. The server de-duplicates on device id plus sequence number, so retries are always safe.
- Cache the website's published conditions file while online and attach a snapshot to each catch; mark it stale if the cached copy is old.

### Testing without hardware

Include a fake-controller mode that generates events, so the app can be built and tested before the real device is ready.

## Cloud: Worker and D1

The website already uses a Cloudflare D1 database. Inspect its Worker, wrangler configuration, schema and authentication first, then extend them. Do not replace anything, and make every schema change a migration.

### API (design, to adapt to the existing Worker)

- Upload a batch of events, idempotent on device id plus sequence number.
- Read and edit the lists (species, rods, actions, trip types).
- Read trips and catches, for the app and later the website.
- Upload a trip's GPS track.
- Authenticate writes with a bearer token held as a Worker secret. Ask Oliver whether catch data may be read publicly or only by him (section 11).

### Tables

| Table | Main columns |
| --- | --- |
| devices | id, name, last\_seen |
| species, rods, actions, trip\_types | id, name, sort order, active flag (soft delete) |
| trips | id, device id, trip number on the device, trip type, start, end, notes |
| action\_log | id, trip, action, start, end |
| catches | id, trip, device id, sequence number, time, species, size cm, fate, depth m, rod, latitude, longitude, accuracy m, voided flag, conditions snapshot (JSON), created, updated |
| track\_points | trip, time, latitude, longitude, accuracy |
| config\_state | current config version |

- Add a unique constraint on catches (device id, sequence number).
- Voiding a catch sets a flag. Nothing is hard-deleted.
- A six-hour trip sampled every 15 seconds is about 1,400 track rows. Check D1's current row and write limits before choosing between one row per point and a compressed track per trip. Those limits are unverified.

## Power budget and measurements

The target is 12 hours of use on one charge, so the average draw should stay near 100 mA or below. The display alone is about 29 mA at full screen according to DFRobot; the ESP32 with Bluetooth connected is not yet measured. At 100 mA over 12 hours the load is about 1.2 Ah, so a battery of 2000 to 3000 mAh leaves a margin once usable capacity (about 80 percent) is allowed for.

Measure each state with the USB-C power analyzer and write the results to `docs/power-measurements.md`:

| State | Record |
| --- | --- |
| Booting | Peak and settled mA |
| Advertising, display off | mA |
| Connected, display at 100 percent | mA |
| Connected, display at 50 percent | mA |
| Connected, display off, light sleep | mA |
| Deep sleep, with and without the low-power jumper cut | mA |
| Catch flow active | mA |
| Vibration pulse | peak mA |

The analyzer measures on the USB side at 5 V, so battery-powered draw will differ somewhat. Note this in the results file and repeat the key measurements once a battery is fitted. Choose the battery from the measured table, not from these estimates.

## Open decisions for Oliver

Ask these when the milestone that needs them is reached. Where Oliver has no preference, pick a sensible default, say what you chose, and carry on.

- [ ] Computer operating system (assumed Windows).
- [ ] Phone model and Android version.
- [ ] What the "actions" are (for example drifting, anchored, trolling, casting, moving spot).
- [ ] Starting lists: species, rod and reel combinations, depth values, and the fish length range.
- [ ] Should catch data be public on the website or private to Oliver?
- [ ] Does the Worker for this project live in the website's existing Worker or a new one?
- [ ] Knob design for the waterproof version (later): a standard sealed encoder with a lip seal, or a magnet through the case wall.
- [ ] Should the controller later show conditions from the phone, such as wind and tide?

## Working agreement for Claude CLI

- Oliver is strong with databases and the Microsoft stack, and new to ESP32 and Android tooling. Explain jargon briefly, one step at a time, and verify each step with him.
- Work in small, testable increments and commit often. Keep `CLAUDE.md` current with decisions, pin assignments, UUIDs and commands.
- Write long comments explaining why, not just what, matching the style of his website code.
- When something is ambiguous, pick the most sensible default, state the assumption briefly and proceed.
- If an approach fails twice, stop, say so plainly, and suggest the faster manual alternative instead of engineering around it.
- Be honest about what has been tested on real hardware and what is only reasoned through.
- Do not edit the website repository unless asked. When website files do change, list exactly which files changed. Oliver deploys by uploading files through GitHub's web Upload files page.
- Never put secrets in the repository.
- LiPo safety: do not connect a battery until its polarity is confirmed with a multimeter, never short it, and do not charge it unattended during development.
