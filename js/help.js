// help.js
// The "?" button at the top right of every page's header bar, and the Help panel (a right-hand column) it opens. Loaded in each page's <head>
// (like install-app.js, so it is the same one line on every page); the button is added once the page is ready.
// The panel opens on the help for the tab you are on and has a strip to read any other tab's help too.
// All the help text lives in HELP_PAGES below: one entry per page (the file name without .html), each a list of
// sections {id, title, html}. Screenshots are in images/help/ and sit in <figure class="help-figure"> blocks; they show
// the signed-out site (the signed-in screens can't be captured without an account), so the signed-in tabs use short
// written walk-throughs instead.

const HELP_TABS = [
  { page: "index", label: "Week Ahead" },
  { page: "conditions", label: "Map" },
  { page: "trip", label: "Trip" },
  { page: "triplogs", label: "Trip Logs" },
  { page: "reports", label: "Reports" },
  { page: "locations", label: "Settings" },
];

function helpFig(src, caption, alt) {
  return `<figure class="help-figure"><img src="images/help/${src}" alt="${alt || caption}" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
}

const HELP_PAGES = {
  index: {
    title: "Week Ahead",
    intro:
      "Week Ahead is the home page. It shows the coming week for every tracked fishing spot on one scrolling timeline, so you can see at a glance which spots and which hours look good, and plan a trip around them. You don't need to sign in to look; signing in lets your filters, pinned spots and planned trips follow you to every device.",
    sections: [
      {
        id: "overview",
        title: "What you are looking at",
        html: `
<p>Each location has its own graph, stacked one under the other. They all share the same time axis, which runs left to right across the whole week, so scrolling sideways moves every graph together. A vertical line labelled <strong>Now</strong> marks the current time. The shaded bands behind the graphs are the days, with sunrise and sunset times and a moon-phase icon at the top of each day.</p>
${helpFig("week-overview.jpg", "Week Ahead on a desktop screen: the filter buttons, then one graph per location (here Kayak and Land based versions of the same spot).")}
<p>A spot that supports both <strong>Kayak</strong> and <strong>Land based</strong> fishing appears twice, once for each, because the same weather and tide can be good for one and poor for the other (the shore direction, ramp access and wind exposure are scored differently).</p>`,
      },
      {
        id: "graph",
        title: "Reading a graph",
        html: `
<ul>
<li><strong>Purple tide curve</strong> with the times of each high and low printed on it. High and low times already include any per-location tide offset set for that spot, so they should match what you see at the water.</li>
<li><strong>Wind</strong>: arrows that point the way the wind is blowing. Hollow markers are the <em>forecast</em>, solid markers are the <em>realtime</em> readings from the nearest weather station, so you can see how the forecast is holding up. The speed axis is in km/h.</li>
<li><strong>Temperature</strong> (forecast and realtime), <strong>water temperature</strong>, <strong>rainfall probability</strong> and <strong>pressure</strong> are drawn as lines. Tap a legend entry on a graph that shows one to hide or show that line.</li>
<li><strong>Dashed red line</strong>: the wind speed limit used when scoring conditions.</li>
<li><strong>Two coloured strips along the bottom</strong>: the upper one (flag icon) is the <em>Location condition</em> for each hour, the lower one (fish icon) is the <em>Fishing condition</em>. Both run from red (poor) through orange to light green (acceptable) and deep green (excellent). Nothing below "acceptable" is ever shown green, and nothing at or above it is ever orange.</li>
<li><strong>Green dotted lines labelled Session start / Session end</strong> mark the stretches that meet your Session Criteria (see below). Their green shading is the qualifying time itself.</li>
<li>For tidal ramps, a shorter-than-normal low can mean the ramp is unusable; the graph shows where the tide crosses that spot's minimum height, and the curve around a shallow low may be reshaped slightly to match what anglers actually see there.</li>
</ul>
<p><strong>Inspecting a single hour:</strong> press and hold on a graph for about two seconds. A tooltip appears with every value for that hour and the reason behind the Fishing score (for example "Fishing 3.4/5 followed by the reason"). Once it is showing, a quick tap anywhere moves it to that point. Hold again for two seconds to switch it off. This is deliberate, so ordinary scrolling and swiping never pops up a tooltip by accident.</p>`,
      },
      {
        id: "filters",
        title: "The filter buttons",
        html: `
${helpFig("week-filters.jpg", "The filter toolbar: Locations, Type, Location Group, Shore Direction and Session Criteria.")}
<p>The row of round buttons above the graphs decides which locations are listed. A small number badge on a button tells you a filter is active on it.</p>
<ul>
<li><strong>Locations</strong> (map pin): choose exactly which spots to show. <em>All</em> and <em>None</em> are shortcuts. Each spot has a <strong>star</strong>: pinned (★) spots always sit at the top of the page.</li>
<li><strong>Type</strong> (kayak / land icons): show Kayak, Land based, or both.</li>
<li><strong>Location Group</strong> (layers icon): show only certain groups of spots, for example "Western Port" or "Port Phillip". You manage the group names in Settings.</li>
<li><strong>Shore Direction</strong> (compass icon): the way the shore faces. Useful for finding spots sheltered from today's wind.</li>
<li><strong>Session Criteria</strong> (sliders icon): what makes a "session", covered in the next section.</li>
</ul>
<p>In the pick lists, <strong>tap once to require</strong> a value, <strong>tap again to exclude</strong> it, and <strong>tap a third time to clear</strong> it. Each list narrows the others, so the choices you see only ever include things that could still match. <em>Clear</em> resets that one filter and <em>Done</em> closes it.</p>
<p class="help-tip">If you see "No locations match the current filters", one of the filters is too strict. Open each filter and press Clear.</p>`,
      },
      {
        id: "sessions",
        title: "Sessions and Session Criteria",
        html: `
<p>A <em>session</em> is a run of consecutive hours when conditions are good enough for you. In the <strong>Session Criteria</strong> panel you set two minimums:</p>
<ul>
<li><strong>Min condition rating</strong>: how good the conditions must be (the 1 to 5 score, shown with the same colours as the strips). The scale uses half-point steps.</li>
<li><strong>Min consecutive hours</strong>: how long it must stay that good. This is a real clock duration, so what you set matches the session lengths shown.</li>
</ul>
<p>Every location is evaluated separately: a stretch of hourly forecast rows that all meet the rating, and run for at least the minimum number of hours, becomes a session. Sessions show on the graph (green dotted start and end lines) and as <strong>session chips</strong> for each spot, which are small tags showing the day and times.</p>
<p><strong>Example:</strong> a minimum rating of 3.5 and a minimum of 3 hours shows only windows of at least three hours where the Fishing condition stays at 3.5 or better. Lower the rating or hours to see more windows, raise them to see only the best.</p>`,
      },
      {
        id: "planning",
        title: "Planning a trip from a session",
        html: `
<p>Open a spot's <strong>ⓘ</strong> button (on its name tag, at the left of its graph) to see its session chips and the planning buttons. The two planning buttons are:</p>
<ul>
<li><strong>+ Fishing times</strong>: you choose the time you want to be on the water, and the page works backwards and forwards from it.</li>
<li><strong>+ Home to home</strong>: you choose the whole outing, door to door, and the page works out the fishing window inside it.</li>
</ul>
<p>To use them: tap a session chip (the graph jumps to it and the planner is "armed"), tap the planning button you want, then <strong>drag across the graph and release</strong>. The page computes a schedule from your range and draws it on the graph as small icons: <em>Leave</em> home, <em>Arrive</em>, <em>Launch</em> (kayak), <em>Fishing</em>, <em>Head back</em>, <em>Driving</em> and <em>Home</em>. The full list of times also appears as a chip under the spot, with a <strong>×</strong> to delete it.</p>
<p><strong>Drive times:</strong> the <em>From</em> drop-down on the planner chooses where the drive is worked out from: one of your <strong>homes</strong> (add and name them on the Map), or <strong>GPS</strong> (where you are right now). It uses real driving directions, so you need to be signed in and have a home. If the drive time can't be found, the chip says so and shows what it could calculate without it.</p>
<p>The set-up, pack-up and travel allowances used for each spot come from the spot's settings (Settings and the Map's location editor).</p>`,
      },
      {
        id: "phone",
        title: "Using it on a phone",
        html: `
${helpFig("week-mobile.jpg", "The same page on a phone: shorter legend labels, the ⓘ button on each name tag, and sideways scrolling for the rest of the week.")}
<ul>
<li><strong>Scroll sideways</strong> for the rest of the week and <strong>scroll down</strong> for more spots.</li>
<li>The <strong>ⓘ</strong> on each name tag opens that spot's details, session chips and planning buttons.</li>
<li>Use <strong>Install app</strong> (top of the page, when shown) to add the site to your home screen. On iPhone and iPad it shows the Share → Add to Home Screen steps instead.</li>
</ul>`,
      },
      {
        id: "data",
        title: "Where the numbers come from and how fresh they are",
        html: `
<p>Forecasts come from <strong>WillyWeather</strong> (tide, wind, temperature, rain, pressure) with weather codes from <strong>Open-Meteo</strong>, and are refreshed by a scheduled job every few hours. The time of the last update is shown at the top of the page ("Updated ..."). If it turns amber, the data is stale and a refresh is overdue.</p>
<p>Names, groups, timings and tide offsets you change in Settings or the Map's location editor appear straight away. Only the forecast numbers and scores wait for the next scheduled update.</p>
<p class="help-tip">The scores are a guide, not a promise. Always check local conditions, marine warnings and your own safety before heading out.</p>`,
      },
    ],
  },

  conditions: {
    title: "Map",
    intro:
      "The Map shows every tracked fishing location as a pin and, once you sign in, your own marks (catches and points of interest), your homes and your past trips. Tap any location to see its conditions graph without leaving the map.",
    sections: [
      {
        id: "overview",
        title: "The map and its pins",
        html: `
${helpFig("map-overview.jpg", "The Map signed out: blue pins are kayak spots, brown pins are land based spots, purple pins are spots that suit both.")}
<ul>
<li><strong>Pan and zoom</strong> with your finger, the mouse wheel or the + and − buttons.</li>
<li>Each pin is a tracked location. The pin colour/icon shows the type: kayak, land based, or both.</li>
<li><strong>Tap a pin</strong> to open the location panel with its conditions graph, session chips and (when signed in) the trips you've done there.</li>
<li><strong>Layers button</strong> (top left): switches the base map between the normal street map and a sea chart. The sea chart is for reference only and is <em>not for navigation</em>. It needs a browser with WebGL; if that isn't available the button is hidden.</li>
<li><strong>Find my location</strong> (crosshair button): centres the map on where you are. Your browser will ask permission the first time.</li>
</ul>`,
      },
      {
        id: "location-panel",
        title: "The location panel and graph",
        html: `
<p>Selecting a pin opens a panel with the same conditions graph used on Week Ahead (tide, wind, pressure, temperature, rain, and the Location and Fishing condition strips), the spot's name, its Kayak / Land based toggle, its session chips and the planning buttons (<strong>+ Fishing times</strong>, <strong>+ Home to home</strong>). See the Week Ahead help for how to read the graph.</p>
<ul>
<li><strong>Double-tap</strong> the graph to expand it. <strong>Hold for 2 seconds</strong> to turn the data-point tooltip on or off.</li>
<li>If you can edit a location (for example one of your own) a <strong>gear</strong> next to its name opens the location editor: display name, group, shore direction, set-up/pack-up and travel times, tide offset, the tide-widening values for shallow lows, and so on. Changes appear straight away.</li>
<li>You can move a location's pin if you have permission; the map shows a hint while a pin is picked up and the next tap puts it down.</li>
</ul>`,
      },
      {
        id: "preview",
        title: "Looking at a spot that isn't tracked",
        html: `
<p>Tap an empty part of the map to look at the conditions for that exact point.</p>
<ul>
<li>Signed out, a tap shows a <strong>preview</strong> graph: a live forecast for that point. It is marked "Preview only" because it isn't a saved location.</li>
<li>Signed in, a tap asks <strong>"What's here?"</strong> with two choices: <em>Add a new mark here</em> or <em>View the conditions graph for this spot</em>. (If you can't add locations, it goes straight to adding a mark.)</li>
<li>In a preview you can set the <strong>Display name</strong>, <strong>Shore</strong> and <strong>Type</strong>, and the scoring is calculated from those. <strong>Add as permanent location</strong> saves it, if your plan has room for another location.</li>
</ul>`,
      },
      {
        id: "marks",
        title: "Marks: catches and points of interest",
        html: `
<p>Signed in, the map also shows your <strong>marks</strong>: each catch or point of interest as a coloured shape. Only you can see your own marks.</p>
<ul>
<li><strong>Tap a mark</strong> to open its details panel: species, size, gear, tide and weather at the time, date and time, GPS position and notes. From there you can edit, copy or delete it.</li>
<li><strong>Add a mark:</strong> tap an empty spot and choose <em>Add a new mark here</em>. The edit form opens with the pick-lists you set up in Settings (species, bait, rig, rod, berley, method and so on).</li>
<li>Tide and weather are filled in for you from the stored conditions at that place and time, so you don't have to type them.</li>
<li><strong>Select several marks:</strong> hold <strong>Ctrl</strong> and drag a box on the map (on a computer) to pick a group, then bulk edit, copy or delete them.</li>
<li>Marks logged on a trip (from the Trip tab or the controller) are also shown here as ordinary catches.</li>
</ul>`,
      },
      {
        id: "toolbar",
        title: "The signed-in toolbar",
        html: `
<ul>
<li><strong>Colour marks by</strong> (palette): choose what decides the mark colour (for example species). It also has the <strong>mark clustering</strong> switch: <em>On</em> groups nearby marks into numbered bubbles; <em>Off</em> (the default) shows every mark and spreads marks that share a spot into a small ring when you zoom in far enough.</li>
<li><strong>Filters</strong> (funnel): show only some marks, for example one species, a date range, a bait or a tide. A number badge tells you how many filters are on and chips on the map list the active ones with a quick way to remove each. Filters work like the Week Ahead ones: tap once to require, again to exclude, a third time to clear.</li>
<li><strong>Add a home</strong> (house with +): tap it, then tap the map where your home is. The home is named after the nearest town. Tap the home's pin to <strong>rename</strong> it (type a new name and press Save name) or delete it. You can have as many homes as you like; drive times use the closest one to where you're heading.</li>
<li><strong>Trips</strong>: lists your past trips grouped by the nearest tracked location, each with a tick box. Ticked trips are drawn on the map (see below).</li>
<li><strong>Import / Export marks</strong> (up-down arrows): see below.</li>
</ul>`,
      },
      {
        id: "trips",
        title: "Seeing past trips on the map",
        html: `
<p>Open <strong>Trips</strong> from the toolbar, find a trip and tick it. The route is drawn as a line (from your phone's GPS track when it has one, otherwise from the positions logged during the trip) with pins for the start and end of the trip, each action, each change and each catch. Hover (or tap) a pin to see what happened and when. A change pin says exactly what changed, such as the action, water condition, depth or rod set-ups. Pins that would overlap are fanned out around a ring with leader lines. Which trips you've ticked is remembered on this device.</p>
<p>Trips are recorded on the <strong>Trip</strong> tab and reviewed on the <strong>Trip Logs</strong> tab.</p>`,
      },
      {
        id: "import-export",
        title: "Import and export (Garmin and Lowrance)",
        html: `
<p>Use the up-down arrows button on the toolbar.</p>
<ul>
<li><strong>Import GPX</strong>: pick a Garmin <code>.gpx</code> or Lowrance <code>.usr</code> file. The map switches to <em>Import review</em>: a side panel lists every mark and trail in the file. Marks you already have are recognised so you don't duplicate them.</li>
<li>Use <strong>Select all new</strong> / <strong>Deselect all</strong>, the search box (species or name) and the tick boxes to choose, then <strong>Import selected</strong>. <strong>Done</strong> leaves import mode; <strong>Cancel import</strong> throws the review away.</li>
<li>The <strong>Trail data</strong> section lists the boat tracks from the file. Tick what to import, and use the eye icons to show or hide trails on the map. Imported trails that look like fishing sessions are added to your trip log.</li>
<li><strong>Export Lowrance</strong> / <strong>Export Garmin</strong>: writes a file with only the marks currently visible, so your filters decide what goes into the file. The shape and colour text for each device comes from the Mark Shape and Colour formats in Settings.</li>
</ul>`,
      },
    ],
  },

  trip: {
    title: "Trip",
    intro:
      "The Trip tab is for recording a day on the water, one tap at a time, while you're fishing. It is designed for a phone. You start a trip, start an Action (the way you are fishing right now), log each catch, and end the trip. Everything is saved to your Trip Log automatically, ready for the Trip Logs and Reports tabs. You must be signed in.",
    sections: [
      {
        id: "idea",
        title: "How a trip is organised",
        html: `
<p>There are three levels, all set up in advance so that on the water you only tap:</p>
<ul>
<li><strong>Trip</strong>: the outing, for example "Saturday kayak". A trip has a name and a list of target species.</li>
<li><strong>Action</strong>: one way of fishing within the trip, for example "Drifting soft plastics" or "Anchored with berley". It carries your fishing method, berley, targets and up to four rod positions. Only one Action runs at a time.</li>
<li><strong>Rod Setup</strong>: one rod, with its rig and bait (and the options those have). An Action holds up to four rod setups, one in each of its four rod positions.</li>
</ul>
<p>Trips, Actions and Rod Setups are managed in <strong>Trip Defaults</strong> (see "Setting up in advance" below).</p>`,
      },
      {
        id: "running",
        title: "Recording a trip: step by step",
        html: `
<ol>
<li><strong>Start trip</strong>: pick one of your trips. Its Actions appear as buttons.</li>
<li><strong>Tap an Action</strong> to start it. If another Action was running it ends first, so switching is a single tap. Tap the running Action again to end it; the screen's hint tells you what a tap will do ("Tap an action to start it" or "Tap the running action to end it, or another to switch").</li>
<li>Starting an Action opens the <strong>rod screen</strong> (next section).</li>
<li><strong>+ Catch</strong> logs a fish. Answer the cards in turn (species, size, whether it was released, and so on). The list starts with the Action's targets and the trip's other targets, and the gear is taken from the running Action. Press <strong>Save catch</strong> at the end.</li>
<li>Keep <strong>Water</strong> condition and <strong>Depth</strong> up to date at the bottom of the screen: tap Water to cycle through the water conditions, and use the depth stepper (<em>One metre deeper / One metre shallower</em>). Each change is recorded against the trip so reports know the conditions you were fishing in.</li>
<li><strong>End trip</strong> when you're done. The screen shows the <em>Time on this trip</em>.</li>
</ol>
<p>The trip survives closing the page, switching tabs or locking your phone. It is kept in your account, so a trip started here can be continued on another device, and the screen re-syncs when you return to it.</p>`,
      },
      {
        id: "rods",
        title: "The rod screen",
        html: `
<p>When an Action is running you see its <strong>four rod positions</strong> as a 2×2 grid. Each filled position shows the rod's name, its bait (with options) and its rig options, with a picture of the bait behind it when you've added one.</p>
<div class="help-diagram" aria-label="Illustration of the 2 by 2 rod grid">
  <div class="help-rod help-rod-on"><b>Rod 1</b><span>Squid · 2 hooks</span></div>
  <div class="help-rod help-rod-on"><b>Rod 2</b><span>Pilchard</span></div>
  <div class="help-rod help-rod-on"><b>Rod 3</b><span>Soft plastic</span></div>
  <div class="help-rod help-rod-off"><b>Empty</b><span>Fill position</span></div>
</div>
<p class="help-caption">An illustration of the grid (not a screenshot): three positions filled, one empty.</p>
<ul>
<li><strong>Tap a rod</strong> to change what's on it: first its bait, then the options of each bait you picked (or just its rig option if it has no bait).</li>
<li><strong>The fish icon</strong> (bottom left of a rod) logs a catch on that rod, so the rod question is skipped.</li>
<li><strong>Tap an empty position</strong> ("Fill position") to put a rod setup there.</li>
<li><strong>X</strong> (top right of a rod) removes it from this action; the setup itself is kept for next time.</li>
<li><strong>Gear icon</strong> (bottom right of a rod) opens Trip Defaults straight onto that rod setup.</li>
<li><strong>Move rods</strong>: tap it, tap a rod to pick it up, then tap another position to drop it there ("Tap a position to drop it there"); if the target is taken the two swap. Use <em>Cancel move</em> to back out.</li>
</ul>
<p>Tap the running Action's button to come back to this screen at any time. <strong>End action</strong> is on it.</p>`,
      },
      {
        id: "defaults",
        title: "Setting up in advance (Trip Defaults)",
        html: `
<p>Trip Defaults is the one place Trips, Actions and Rod Setups are created and edited. Open it from the idle Trip screen, or from the <strong>gear</strong> on a Trip, Action or rod. It is a full-screen hub: pick or add a <strong>Trip</strong>, then its <strong>Actions</strong>, then each Action's <strong>Rod Setups</strong>.</p>
<ul>
<li>Choices (species, bait, rig, rod, berley, method, water condition) come from your Mark Lists in Settings. Add the values you use there first.</li>
<li>Each Action has four rod positions. Tap a free region to put a setup there; a setup can hold one region; regions another setup holds are greyed out.</li>
<li>Rig and bait can have <strong>options</strong> (a sub list, for example hook size or colour). They appear as follow-up choices.</li>
<li>Opened from a running trip, the choices are shown as summary chips at the top; tap one to edit just that category. Changes made during a trip are logged as a <em>change</em> in the trip log.</li>
<li>Deleting a rod setup permanently is only offered when you open Trip Defaults from the idle screen, never mid-trip.</li>
</ul>`,
      },
      {
        id: "tips",
        title: "Good to know",
        html: `
<ul>
<li>If you're offline the entries are queued on your phone and sent when you're back in coverage, so nothing is lost.</li>
<li>Catches are saved without tide or weather; they are filled in automatically a little later from the stored forecast and observations.</li>
<li>If your trip is also recorded by the Fishing Controller (a separate handheld device), both share the same running trip.</li>
<li>Mistakes are fixed afterwards on the <strong>Trip Logs</strong> tab, where every line can be edited, added or deleted.</li>
<li>Not signed in? Sign in from the Settings tab: the Trip tab needs an account.</li>
</ul>`,
      },
    ],
  },

  triplogs: {
    title: "Trip Logs",
    intro:
      "Trip Logs is your record of every trip, line by line. Pick a trip from the list at the top to read what happened, when, with what gear and in what conditions, and to correct anything that was logged wrongly. It is only available when you're signed in.",
    sections: [
      {
        id: "list",
        title: "The list of trips",
        html: `
<p>Each trip is one row, newest first, showing:</p>
<ul>
<li>the <strong>date</strong>, the <strong>trip</strong> name and the <strong>start to end</strong> time,</li>
<li>the <strong>duration</strong> of the whole trip and <strong>Fished</strong>, the time that an Action was actually running,</li>
<li>how many <strong>actions</strong> and <strong>catches</strong> there were,</li>
<li>flags: <em>approx. times</em> (times were estimated, for example for trips rebuilt from old marks), <em>weather pending</em> (tide and weather haven't been filled in yet; this clears by itself) and <em>no end logged</em> (the trip wasn't ended).</li>
</ul>
<p>Use <strong>Trip</strong>, <strong>From date</strong> and <strong>To date</strong> above the list to narrow it, and <strong>Clear</strong> to reset them. Click a row to open it.</p>`,
      },
      {
        id: "lines",
        title: "The lines of one trip",
        html: `
<p>Opening a trip shows its log lines in time order. For each line you'll see the time and how long after the start it was (<code>+h:mm</code>), the event, the action, the gear on each rod, water and depth, tide and weather, how long each action ran, and the position. A <code>~</code> beside a time means it is approximate.</p>
<p>The events are:</p>
<ul>
<li><strong>trip start / trip end</strong>: the outing begins and ends.</li>
<li><strong>action start / action end</strong>: an Action starts or stops. Starting a new Action implicitly ends the previous one.</li>
<li><strong>change</strong>: something changed while the action ran (water condition, depth, rod set-ups, bait).</li>
<li><strong>catch</strong>: a fish, with species, size, whether it was released, and the rod that caught it.</li>
</ul>
<p>The gear is shown per rod in separate columns: Rod setup, Rod, Rig, Rig options, Bait, Bait options. A state (the action, rods, water and depth) is taken to last from its line until the next line, which is how the reports work out hours fished with each bait.</p>`,
      },
      {
        id: "edit",
        title: "Fixing and adding lines",
        html: `
<ul>
<li><strong>Edit</strong> on a line opens an in-place editor with every field: time, event, action, water, depth, tide, weather, wind, temperatures, pressure, berley, method, targets, species, size, released, position, and the rod rows. Pick-lists come from your Mark Lists; choosing a Rod Setup fills the whole rod row. Blank text clears a field. Save applies the change.</li>
<li><strong>+ Add line</strong> inserts a line you forgot, such as a catch you didn't log.</li>
<li><strong>Delete line</strong> removes one line.</li>
<li><strong>Name / Rename</strong> on a trip's row sets the trip name for every line of it.</li>
<li><strong>Delete</strong> on a trip's row deletes the whole trip (after asking you to confirm). Its catch marks stay on the Map.</li>
</ul>
<p>Once you've edited, added or deleted anything in a trip, that trip is protected: automatic rebuilds will never overwrite your corrections. Tide and weather that are still blank are filled in by the site, but they never overwrite a value you set.</p>`,
      },
      {
        id: "deleted",
        title: "Deleted trips and lines, and Restore",
        html: `
<p>Deleting is gentle. Deleted trips and lines vanish from the logs and reports at once, but they're kept for <strong>30 days</strong>. A <strong>Deleted</strong> card appears at the bottom of the page listing them, with how many lines and the date they'll be removed for good. Press <strong>Restore</strong> to bring a trip back.</p>`,
      },
      {
        id: "links",
        title: "Links from elsewhere",
        html: `
<p>A catch mark on the Map has a <strong>Trip log</strong> link that opens this tab on the right trip and line. You can also share the address of a trip yourself (for example <code>triplogs.html#run=...</code>).</p>
<p>Old trips from before the log existed can be rebuilt from marks in <strong>Settings → Fishing Controller</strong> ("Build trip log from past trips" / "from old sessions").</p>`,
      },
    ],
  },

  reports: {
    title: "Reports",
    intro:
      "Reports turn your logged trips into answers: when do you catch fish, on what tide, with what gear and where? They're built from your <strong>trip log</strong>, so only catches recorded on a trip are counted. You must be signed in, and the more trips you log, the more useful these get.",
    sections: [
      {
        id: "filters",
        title: "Filtering what is counted",
        html: `
<p>The <strong>gear icon</strong> at the top opens the filters. Everything on the page, every chart and table, then uses only the trips and catches that match. A number badge shows how many filters are on. Use the date range to compare seasons, species to focus on one fish, and so on. The line under the filters summarises how many catches and sessions are being counted.</p>`,
      },
      {
        id: "sessions",
        title: "Sessions",
        html: `
<p>Steps through your sessions one at a time, newest first, with <strong>◀ Previous session</strong> and <strong>Next session ▶</strong> (within the date range you've set). The graph covers from 12 hours before the session to 12 hours after: the same conditions graph as the rest of the site, with the session shaded green and a dot for every catch in that species' colour. Use <strong>Condition scored for: Kayak / Land based</strong> to choose which scoring the strips use. Open <strong>Table view</strong> for the same catches as rows (date, time, species, length, tide, wind and weather).</p>`,
      },
      {
        id: "tide-clock",
        title: "Tide clock",
        html: `
<p>Answers <em>"when in the tide do I catch fish?"</em>. Each session is laid onto one full tide cycle (both highs and both lows), measured in hours since the lower low water, about 25 hours in all. The blue curve is a typical tide built from your sessions, with the differences between the highs and the lows exaggerated so they stand out. Bars show how much you fished and how many fish you caught at each point, and the catch rate shows where you do best. A bump in the catch rate with plenty of fishing time behind it is a genuine pattern; a spike with very little time behind it is probably luck.</p>`,
      },
      {
        id: "tide-stage",
        title: "Catch rate by tide stage",
        html: `
<p>Every logged catch, grouped by the tide at the time. Choose the columns with <strong>Tide condition</strong> (for example incoming, outgoing, slack) or <strong>Tide extreme</strong> (the kind of high or low); the other is stacked inside each column. Hover a bar for the numbers.</p>`,
      },
      {
        id: "gear",
        title: "Bait, rig and rod effectiveness",
        html: `
<p>Tables of catch counts for each bait, rig and rod you've used. A session's own gear is carried onto every catch logged during it. Use it to see what's actually working, and keep in mind that a bait you use a lot will naturally have more catches, so compare how long you fished with each, not just the count.</p>`,
      },
      {
        id: "location",
        title: "Catches by location",
        html: `
<p>Every catch matched to its nearest tracked location, so you can see which spots are producing.</p>`,
      },
      {
        id: "notes",
        title: "What is and isn't counted",
        html: `
<ul>
<li>Only your own catches logged on a trip. Catches made by tapping the map, imported from a Garmin or Lowrance file without being on a trip, or logged by anyone else are <strong>not</strong> included.</li>
<li>Catches converted from older sessions can have blank tide or weather until the site has filled them in.</li>
<li>Small numbers mislead. With only a handful of trips a pattern may be coincidence, so treat the reports as hints.</li>
</ul>`,
      },
    ],
  },

  locations: {
    title: "Settings",
    intro:
      "Settings is where you sign in and where your personal lists and preferences live: your location groups, the pick-lists used for logging, the Fishing Controller pairing and your messages to the site's owner. Many settings save the moment you change them; there is no separate Save step.",
    sections: [
      {
        id: "signin",
        title: "Signing in",
        html: `
${helpFig("settings-signin.jpg", "Settings when you're signed out: what signing in gets you, and the Sign in with Google button.")}
<p>Press <strong>Sign in with Google</strong>. Without signing in you can still browse Week Ahead and the Map for the shared locations. Signed in you can log catches and trips, see reports, add homes, set your own location timings and keep your lists. Everything personal is private to you.</p>
<p>When you're signed in the card shows who you are, with <strong>Sign out</strong>. Your filters, pinned spots, planned trips and other settings follow you across devices, so signing in on a new phone brings them with you. Things stored only on one device (like which trips are ticked on the Map) don't move.</p>
<p class="help-tip">The site is served from fish2catch.app and, for now, yepyepyep.app. Browser sign-in data isn't shared between them, so sign in again on whichever one you use.</p>`,
      },
      {
        id: "contact",
        title: "Contact",
        html: `<p>Questions, ideas or a problem? Type a message (up to 2000 characters) and press <strong>Send</strong>. The reply shows on this page.</p>`,
      },
      {
        id: "groups",
        title: "Location Groups",
        html: `<p>The names you can give to groups of spots, for example by region. Once defined, you assign a group to each location (in the Map's location editor) and use the groups as a filter on Week Ahead. <strong>+ Add group</strong> creates one and each can be removed. Groups shared by the site (Public) are shown too, but can't be changed.</p>`,
      },
      {
        id: "lists",
        title: "Fishing Mark Lists",
        html: `
<p>The pick-lists used whenever you log a catch or mark: species, bait, rig, rod, berley, fishing method, weather, tide and water conditions, mark types, and more. Add the values you really use. They then appear as buttons when you log a catch, in Trip Defaults, in the Trip Logs editor and in filters.</p>
<ul>
<li>Values shared by the site are shown with a badge and can't be edited; your own values are added alongside.</li>
<li>Some values can have a <strong>Sub List</strong> of options (a rig's hook sizes, a bait's colours). A Rig's sub list can be overridden privately.</li>
<li>Values can have <strong>pictures</strong> (up to 12). They appear next to the choice when you log a catch, and Species pictures power "select by image".</li>
<li>Species can carry size and catch limits and a colour; the colour is the mark's colour on the Map.</li>
<li>Removing a value asks you first and tells you how many marks use it and how many pictures go with it.</li>
<li><strong>Restore missing values</strong> re-adds names that your existing marks use but that are no longer in your lists (names only, not pictures or limits).</li>
</ul>
<p><strong>Mark Shape Formats</strong> and <strong>Mark Colour Formats</strong> define the named shapes and colours for the Map and the exact text each device's export file should use (Garmin or Lowrance). Colour is usually set per species; shape per mark type.</p>`,
      },
      {
        id: "controller",
        title: "Fishing Controller and trip log rebuilds",
        html: `
<p>The Fishing Controller is a separate handheld device that talks to a phone app. The phone app signs in with its own <strong>token</strong>: press <strong>+ Create token</strong>, copy the token (it is shown once only) into the app, and <strong>revoke</strong> it here if a phone is lost. A token can only be used by the controller app, never to sign in to the website.</p>
<p>Two buttons rebuild the trip log of older activity: <strong>Build trip log from past trips</strong> (controller trips) and <strong>Build trip log from old sessions</strong> (Session Start/End and catch marks from before trips existed). They're safe to repeat and never overwrite a trip you've edited.</p>`,
      },
    ],
  },
};

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  function currentPage() {
    const file = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "") || "index";
    return HELP_PAGES[file] ? file : "index";
  }

  let overlay = null;
  let lastFocus = null;
  let shownPage = null;

  function render(page) {
    shownPage = page;
    const data = HELP_PAGES[page];
    const tabs = HELP_TABS.map((t) => `<button type="button" class="help-tab${t.page === page ? " active" : ""}" data-help-page="${t.page}" aria-pressed="${t.page === page}">${t.label}</button>`).join("");
    const toc = data.sections.map((s) => `<a href="#help-${s.id}" data-help-jump="${s.id}">${s.title}</a>`).join("");
    const body = data.sections.map((s) => `<section class="help-section" id="help-${s.id}"><h3>${s.title}</h3>${s.html}</section>`).join("");
    overlay.querySelector(".help-dialog").innerHTML = `
      <div class="help-head">
        <h2 id="helpTitle">Help: ${data.title}</h2>
        <button type="button" class="help-close" aria-label="Close help">&times;</button>
      </div>
      <div class="help-tabs" role="group" aria-label="Help for each tab">${tabs}</div>
      <div class="help-scroll">
        <p class="help-intro">${data.intro}</p>
        <nav class="help-toc" aria-label="In this help">${toc}</nav>
        ${body}
        <p class="help-foot">Something missing or unclear? Send a message from the Settings tab (Contact).</p>
      </div>`;
    overlay.querySelector(".help-close").addEventListener("click", close);
    overlay.querySelectorAll("[data-help-page]").forEach((b) => b.addEventListener("click", () => render(b.dataset.helpPage)));
    overlay.querySelectorAll("[data-help-jump]").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const el = overlay.querySelector("#help-" + a.dataset.helpJump);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
    overlay.querySelector(".help-close").focus();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    if (overlay) return;
    lastFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.className = "help-overlay";
    overlay.innerHTML = `<div class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="helpTitle"></div>`;
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    render(currentPage());
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKey);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function addButton() {
    const bar = document.querySelector(".topbar");
    if (!bar || document.getElementById("helpBtn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "helpBtn";
    btn.className = "help-btn";
    btn.title = "Help";
    btn.setAttribute("aria-label", "Help");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.textContent = "?";
    btn.addEventListener("click", open);
    bar.appendChild(btn);
  }

  function init() {
    addButton();
    if (location.hash === "#help") open(); // a link to <page>#help opens the Help straight away
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
