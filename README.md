# Xen'drik Hexcrawl v0.1.5

Updates from v0.1.4.1:
- Skill-specific chat prompts, with one roll button for each eligible party actor who has the skill in actor.system.skills.
- Difficulty tiers Common Sense (-5), Skilled (+0), Expert (+5), Outlandish (+10) applied to the base tracking DC and condition modifier.
- Tracking DC is now a positive-integer input.
- Manual skill records can be Used Only, Success, or Failure, with Undo.
- Party actors display their prototype token artwork, falling back to portrait.
- Token movement while paused is queued and processed after an encounter resolves rather than silently discarded.

Note: Chat prompt skill rolls use dnd5e actor.rollSkill (or rollSkillCheck fallback) and are not a dependency on Midi-QOL. A player must own the selected actor to roll. Foundry 14 + D&D 6.x runtime testing is recommended. Existing saved journeys are preserved.

Install the module ZIP as usual, replacing v0.1.4.1. The repository ZIP includes editable source.
