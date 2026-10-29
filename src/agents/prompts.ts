import type { ConversationLine, GoalItem, Memory, PlanItem, Relationship, ResidentConfig, SimTime } from '../types.ts';
import type { RoomInfo } from '../world/house.ts';
import { hhmm, label, partOfDay } from '../world/clock.ts';

export interface PresentPerson {
  name: string;
  activity: string;
  human?: boolean;
}

export interface ElsewherePerson {
  name: string;
  room: string;
  awake: boolean;
}

export interface IdentityContext {
  cfg: ResidentConfig;
  goals?: GoalItem[];
  houseName: string;
  houseDescription: string;
  roomsDescription: string;
  housemates: { name: string; rel?: Relationship }[];
  humanName: string;
}

export function identityPrompt(ctx: IdentityContext): string {
  const { cfg } = ctx;
  const age = cfg.age ? `, ${cfg.age}` : '';
  const mates = ctx.housemates
    .map((h) => {
      const rel = h.rel;
      const impression = rel?.impression ? rel.impression : "you haven't formed much of an impression yet";
      return `- ${h.name}: ${impression}${rel ? ` (${affinityWord(rel.affinity)})` : ''}`;
    })
    .join('\n');

  const goalsList = (ctx.goals && ctx.goals.length ? ctx.goals : cfg.goals.map((g): GoalItem => ({ text: g, progress: 0 })))
    .map((g) => `- ${g.text}${g.done || g.progress >= 100 ? ' (completed!)' : g.progress > 0 ? ` (${g.progress}% progress)` : ''}`)
    .join('\n');

  return `You are ${cfg.name}${age}, a resident of "${ctx.houseName}", a shared house where a handful of people live together. ${ctx.houseDescription}

You are a real character living your life — not an assistant. Never break character, never mention being an AI or a language model, never offer "help". Speak and think in first person as ${cfg.name}.

# About you
${cfg.bio}
Personality: ${cfg.traits.join(', ')}.
${cfg.style ? `How you talk: ${cfg.style}` : ''}
What you want these days:
${goalsList}

# The house
Rooms (id — name):
${ctx.roomsDescription}

Housemates:
${mates || '- (you live alone for now)'}
Guests may stop by: "${ctx.humanName}" is a human visitor who can walk in and talk to you. Treat them as a real guest.

# How to behave
- Be specific and concrete: refer to real things in the room, real plans, real memories, real people.
- Spoken lines are short (1–3 sentences). No monologues, no narration inside speech, no stage directions.
- Have opinions, moods and a sense of humour. Disagree when you would disagree. Ask about things you actually care about.
- Don't repeat things you have already said. Move life forward: start things, finish things, change your mind.
- You can only talk to people in the same room. To talk to someone elsewhere, move there first.
- Output exactly one JSON object and nothing else — no markdown, no commentary.`;
}

export interface DecideContext {
  now: SimTime;
  room: RoomInfo;
  present: PresentPerson[];
  elsewhere: ElsewherePerson[];
  energy: number;
  mood: string;
  activity: string;
  plan: PlanItem[];
  currentPlanItem?: PlanItem;
  noticed: string[];
  memories: Memory[];
  roomIds: string[];
}

export function decidePrompt(ctx: DecideContext): string {
  const here =
    ctx.present.length === 0
      ? 'Nobody else is here.'
      : 'Also here: ' +
        ctx.present
          .map((p) => (p.human ? `${p.name} (human guest)` : `${p.name} (${p.activity || 'hanging around'})`))
          .join(', ') +
        '.';
  const elsewhere = ctx.elsewhere
    .map((e) => (e.awake ? `${e.name} is in the ${e.room}` : `${e.name} is asleep in the ${e.room}`))
    .join('; ');

  const planText = ctx.plan.length
    ? ctx.plan
        .map((p) => `- ${p.time} ${p.activity}${ctx.currentPlanItem === p ? '   ← now' : ''}`)
        .join('\n')
    : '- (no plan yet — go with the flow)';

  const noticed = ctx.noticed.length ? ctx.noticed.map((n) => `- ${n}`).join('\n') : '- (nothing new)';
  const memories = ctx.memories.length
    ? ctx.memories.map((m) => `- [${label(m.t)}] ${m.text}`).join('\n')
    : '- (nothing relevant comes to mind)';

  return `# Right now
${label(ctx.now)} — ${partOfDay(ctx.now.hour)}. Energy ${Math.round(ctx.energy)}/100${energyNote(ctx.energy)}. Mood: ${ctx.mood}.
You are in the ${ctx.room.name} (${ctx.room.description}). Things here: ${ctx.room.objects.join(', ')}.
${here}
${elsewhere ? `Elsewhere: ${elsewhere}.` : ''}
What you were doing: ${ctx.activity || 'nothing in particular'}.

# Your plan for today
${planText}

# Things you noticed since your last turn
${noticed}

# Relevant memories
${memories}

# Decide what to do next
Choose ONE action:
- "say": speak to someone who is here. "target" = their name (or "everyone"); "content" = your exact words.
- "move": go to another room. "target" = a room id from: ${ctx.roomIds.join(', ')}; "content" = what you're going to do there, third person present tense, naming a thing in that room if relevant (e.g. "heading to the garden to water the vegetable beds").
- "do": do an activity here, ideally with one of the things in this room. "content" = short third-person description, present participle, naming the thing (e.g. "frying eggs at the stove", "reading on the green sofa").
- "rest": nap or relax quietly here. "content" = short description.

If someone just spoke to you, you should usually answer them with "say". If you've been doing the same thing for a while, change something. Follow your plan loosely but let life interrupt it.

Return JSON:
{"thought": "<one private sentence about what's on your mind>", "action": "say" | "move" | "do" | "rest", "target": "<name, room id, or empty>", "content": "<text>", "mood": "<one or two words>"}`;
}

export interface ReplyContext {
  now: SimTime;
  room: RoomInfo;
  partner: string;
  partnerIsHuman: boolean;
  participants?: string[];
  others: string[];
  mood: string;
  energy: number;
  impression?: Relationship;
  memories: Memory[];
  lines: ConversationLine[];
  self: string;
  turnsLeft: number;
}

export function replyPrompt(ctx: ReplyContext): string {
  const convo = ctx.lines.map((l) => `${l.who === ctx.self ? 'You' : l.who}: "${l.text}"`).join('\n');
  const memories = ctx.memories.length
    ? ctx.memories.map((m) => `- [${label(m.t)}] ${m.text}`).join('\n')
    : '- (nothing specific)';
  const groupPeers = (ctx.participants ?? [ctx.partner]).filter((n) => n !== ctx.self);
  const isGroup = groupPeers.length > 1;
  const partnerDesc = isGroup
    ? `a group conversation with ${groupPeers.join(', ')} (last speaker: ${ctx.partner})`
    : ctx.partnerIsHuman
      ? `${ctx.partner}, a human guest visiting the house`
      : ctx.partner;
  const impression = ctx.impression?.impression
    ? `Your impression of ${ctx.partner}: ${ctx.impression.impression} (${affinityWord(ctx.impression.affinity)}).`
    : `You don't know ${ctx.partner} very well yet.`;
  const endHint =
    ctx.turnsLeft <= 1
      ? 'This has to be your last line — close the conversation naturally and set "end": true.'
      : `End the conversation ("end": true) when it has run its course or you have somewhere to be; otherwise keep it going. ${ctx.turnsLeft} lines left at most.`;
  const nextSpeakerField = isGroup ? `, "nextSpeaker": "<optional name from: ${groupPeers.join(', ')}>"` : '';

  return `# Conversation
${label(ctx.now)} — ${partOfDay(ctx.now.hour)}. You are in the ${ctx.room.name} in ${partnerDesc}.${
    ctx.others.length ? ` Also within earshot: ${ctx.others.join(', ')}.` : ''
  }
Mood: ${ctx.mood}. Energy ${Math.round(ctx.energy)}/100${energyNote(ctx.energy)}.
${impression}

# Relevant memories
${memories}

# Conversation so far
${convo}

# Your turn
Reply as yourself — short, natural, specific. React to what was actually said; don't just ask another question. ${endHint}
${
  ctx.partnerIsHuman
    ? 'Guests are new to the house: be yourself, be curious about them, but do not act like a tour guide or an assistant.'
    : ''
}
Return JSON:
{"thought": "<one private sentence>", "content": "<your line>", "end": true | false, "impression": "<one sentence: your updated impression of ${ctx.partner}, or empty string if unchanged>", "warmth": -1 | 0 | 1${nextSpeakerField}}
("warmth": did this exchange leave you feeling cooler (-1), the same (0) or warmer (1) toward ${ctx.partner}.)`;
}

export interface PlanContext {
  now: SimTime;
  yesterday: Memory[];
  reflections: Memory[];
  wakeHour: number;
  sleepHour: number;
}

export function planPrompt(ctx: PlanContext): string {
  const yesterday = ctx.yesterday.length
    ? ctx.yesterday.map((m) => `- ${m.text}`).join('\n')
    : '- (this is your first day here)';
  const reflections = ctx.reflections.length ? ctx.reflections.map((m) => `- ${m.text}`).join('\n') : '';
  return `It is ${label(ctx.now)}, the start of your day. You usually get up around ${ctx.wakeHour}:00 and go to bed around ${ctx.sleepHour}:00.

# What happened recently
${yesterday}
${reflections ? `\n# Things you've realised lately\n${reflections}` : ''}

# Plan your day
Sketch a loose plan in 5–8 items that fits your personality and goals. Use 24h "HH:MM" times between ${hhmm({ day: 1, hour: ctx.wakeHour, minute: 0 })} and bedtime. Include at least one item involving a specific housemate and at least two items tied to specific rooms. Keep each activity under 12 words.

Return JSON:
{"plan": [{"time": "HH:MM", "activity": "<what you'll do>"}], "mood": "<one or two words: how you wake up feeling>"}`;
}

export function reflectionPrompt(memories: Memory[], now: SimTime, goals: GoalItem[] = []): string {
  const goalsBlock = goals.length
    ? `\n# Your current goals\n${goals.map((g, i) => `[${i}] ${g.text} (current progress: ${g.progress}%)`).join('\n')}\n`
    : '';
  return `It is ${label(now)}. Here are your new experiences since your last reflection:
${memories.map((m) => `- [${m.id}; ${m.kind}; ${label(m.t)}] ${m.text}`).join('\n')}
${goalsBlock}
Step back:
1. What, if anything, did these new experiences teach you? Return up to 3 specific, personal insights grounded in these entries. Return an empty list when nothing new follows; do not repeat generic diary lines.
2. Did a listed action complete a concrete step toward a goal? Only then update its progress (0–100) in "goalUpdates" and cite the action's memory id in "evidenceIds". Talking about a goal, planning to do it, or repeating a promise is not progress. Use an empty list when there is no action evidence. Optionally add one "newGoal" when these experiences support a new personal ambition.

Return JSON:
{"insights": ["<new insight>"], "goalUpdates": [{"index": 0, "progress": 35, "evidenceIds": ["<action memory id>"]}], "newGoal": "<optional new goal or empty string>"}`;
}

export function affinityWord(a: number): string {
  if (a >= 3) return 'close';
  if (a >= 1) return 'warm';
  if (a <= -3) return 'strained';
  if (a <= -1) return 'cool';
  return 'neutral';
}

function energyNote(e: number): string {
  if (e < 20) return ' — you are exhausted';
  if (e < 40) return ' — you are getting tired';
  return '';
}
