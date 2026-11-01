# Xen'drik Hexcrawl & Journeys — v0.1.3

Foundry VTT V14, D&D 5e system v6.0.6.

## What's new
- Native **Journeys** sidebar tab (using the Foundry V14 sidebar API demonstrated by Dice So Nice).
- Create and reopen named journeys, group journeys into folders, rename, move, or delete inactive journeys.
- Each journey saves its own settings, party, progress, day log, and skill checks in world settings.
- Previous v0.1.2 journey data is imported automatically if nonempty.
- Removed the Game Settings checkbox launcher. Open journeys from the sidebar.

## Known limitations
- The build has not been tested in a running Foundry V14 instance. Please back up your world before installation.
- Only one journey should be active at a time for automated token travel. Do not switch the active journey while another is in progress.
- Skill check automation and Traveler's Curse token displacement are not fully implemented; use the manager's manual controls.
- Exhaustion applies the numeric system exhaustion value, but does not automatically implement every house-rule roll/DC modifier.
- Simple Calendar integration is planned but optional.

## Install
Use the module.json manifest asset from the latest GitHub Release. Upload both module.json and the versioned ZIP as release assets.
