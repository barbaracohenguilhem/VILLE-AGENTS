import type { ProviderMode, ProviderStatus } from './llm/types.ts';

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible' | 'huggingface' | 'offline';
export type Facing = 'up' | 'down' | 'left' | 'right';
export type FloorStyle = 'wood' | 'tile' | 'carpet' | 'grass' | 'concrete' | 'stone';
export type WalkPurpose = 'move' | 'wander' | 'approach' | 'object' | 'bed' | 'visit';

export interface Tile {
  x: number;
  y: number;
}

/** A piece of furniture or decor as written in house.json (coordinates relative to the room). */
export interface ObjectConfig {
  name: string;
  kind?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  facing?: Facing;
}

export interface RoomConfig {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  floor?: FloorStyle;
  outdoor?: boolean;
  /** Plain strings are auto-placed as generic boxes; objects are placed exactly. */
  objects: (string | ObjectConfig)[];
  /** Interior floor rectangle in tiles (walls are added around it automatically). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomView {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  floor: FloorStyle;
  outdoor: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Furniture resolved to absolute tile coordinates. */
export interface PlacedObject {
  id: string;
  name: string;
  kind: string;
  room: string;
  x: number;
  y: number;
  w: number;
  h: number;
  blocking: boolean;
  /** Can be stood/sat/lain on as a destination (chairs, sofas, beds). */
  sit: boolean;
  facing: Facing;
}

/** Tile codes in GridView.cells: >= 0 is a room index, negatives are structure. */
export const CELL = { VOID: -1, WALL: -2, FENCE: -3, DOOR: -4 } as const;

export interface GridView {
  width: number;
  height: number;
  cells: number[];
}

export interface Look {
  skin: string;
  hair: string;
  pants: string;
  shirt: string;
}

export interface ResidentConfig {
  name: string;
  emoji: string;
  color: string;
  enabled?: boolean;
  provider: ProviderKind;
  model?: string;
  /** Overrides the provider's API base URL (defaults: OpenAI / Anthropic endpoints, or OPENAI_COMPAT_BASE_URL). */
  baseUrl?: string;
  /** Name of the env var holding this resident's API key (defaults per provider). */
  apiKeyEnv?: string;
  /** Extra fields merged into the provider request body (temperature, reasoning_effort, ...). */
  params?: Record<string, unknown>;
  age?: number;
  bio: string;
  traits: string[];
  style?: string;
  goals: string[];
  homeRoom: string;
  startRoom?: string;
  wakeHour?: number;
  sleepHour?: number;
  /** Sprite colours; anything omitted is derived from the name. */
  look?: Partial<Look>;
}

export interface HouseConfig {
  name: string;
  description: string;
  startHour: number;
  tick: {
    realSeconds: number;
    simMinutes: number;
    /** How many residents may be calling an LLM at the same time. */
    concurrentThinkers: number;
    conversationMaxTurns: number;
  };
  movement?: {
    /** Real milliseconds to cross one tile at 1× speed. */
    tileMs?: number;
    /** Chance per second that an idle resident strolls to a nearby tile. */
    wanderChance?: number;
  };
  memory: {
    retrieveTop: number;
    reflectionThreshold: number;
    maxMemories: number;
  };
  human: {
    name: string;
    emoji: string;
    color: string;
    startRoom: string;
    look?: Partial<Look>;
  };
  rooms: RoomConfig[];
  residents: ResidentConfig[];
}

export interface SimTime {
  day: number;
  hour: number;
  minute: number;
}

export interface PlanItem {
  time: string;
  activity: string;
}

export interface GoalItem {
  text: string;
  progress: number;
  done?: boolean;
}

export interface Relationship {
  impression: string;
  affinity: number;
  interactions: number;
}

export type MemoryKind = 'observation' | 'conversation' | 'action' | 'thought' | 'reflection' | 'plan';

export interface Memory {
  id: string;
  kind: MemoryKind;
  t: SimTime;
  tick: number;
  text: string;
  importance: number;
  refs: string[];
}

export type ActionKind = 'say' | 'move' | 'do' | 'rest';

export interface Action {
  thought: string;
  action: ActionKind;
  target: string;
  content: string;
  mood: string;
}

export interface ConversationReply {
  thought: string;
  content: string;
  end: boolean;
  impression: string;
  warmth: number;
  nextSpeaker?: string;
}

export interface ConversationLine {
  who: string;
  text: string;
}

export interface WalkView {
  path: Tile[];
  tileMs: number;
  /** Milliseconds already elapsed when the snapshot was taken. */
  elapsed: number;
  toRoom: string;
  purpose: WalkPurpose;
}

interface BaseEvent {
  id: string;
  t: SimTime;
  tick: number;
}

export type VilleEvent =
  | (BaseEvent & { type: 'clock' })
  | (BaseEvent & {
      type: 'say';
      room: string;
      who: string;
      to: string;
      text: string;
      conversationId?: string;
      human?: boolean;
    })
  | (BaseEvent & { type: 'move'; who: string; fromRoom: string; toRoom: string; text: string; human?: boolean })
  | (BaseEvent & {
      type: 'walk';
      who: string;
      human?: boolean;
      path: Tile[];
      tileMs: number;
      fromRoom: string;
      toRoom: string;
      purpose: WalkPurpose;
    })
  | (BaseEvent & { type: 'pos'; who: string; human?: boolean; x: number; y: number; facing: Facing; room: string })
  | (BaseEvent & { type: 'do'; room: string; who: string; text: string })
  | (BaseEvent & { type: 'rest'; room: string; who: string; text: string })
  | (BaseEvent & { type: 'sleep'; room: string; who: string; asleep: boolean })
  | (BaseEvent & { type: 'thought'; who: string; text: string })
  | (BaseEvent & { type: 'mood'; who: string; mood: string; energy: number; activity: string })
  | (BaseEvent & { type: 'reflection'; who: string; insights: string[] })
  | (BaseEvent & { type: 'goal'; who: string; goal: string; progress: number; done?: boolean })
  | (BaseEvent & { type: 'plan'; who: string; plan: PlanItem[] })
  | (BaseEvent & { type: 'system'; text: string; level: 'info' | 'warn' | 'error' })
  | (BaseEvent & {
      type: 'llm';
      who: string;
      provider: string;
      model: string;
      ms: number;
      ok: boolean;
      mode: ProviderMode;
      status: ProviderStatus;
      online: boolean;
      requests: number;
      note?: string;
      retryAt?: number;
      skipped?: boolean;
      error?: string;
    });

export type EventType = VilleEvent['type'];

export interface MoverView {
  name: string;
  emoji: string;
  color: string;
  look: Look;
  room: string;
  x: number;
  y: number;
  facing: Facing;
  walk?: WalkView;
}

/** What the UI needs to know about a resident. */
export interface ResidentView extends MoverView {
  provider: ProviderKind;
  model: string;
  online: boolean;
  mode: ProviderMode;
  status: ProviderStatus;
  canComplete: boolean;
  retryAt?: number;
  note?: string;
  awake: boolean;
  mood: string;
  energy: number;
  activity: string;
  bio: string;
  traits: string[];
  goals: string[];
  goalsState?: GoalItem[];
  relationships?: Record<string, Relationship>;
  age?: number;
}

export interface ResidentDetail extends ResidentView {
  plan: PlanItem[];
  relationships: Record<string, Relationship>;
  reflections: Memory[];
  memories: Memory[];
}

export type HumanView = MoverView;

export interface LLMStats {
  calls: number;
  errors: number;
  totalMs: number;
  requests: number;
  demoCalls: number;
  skipped: number;
}

export interface Snapshot {
  house: {
    name: string;
    description: string;
    rooms: RoomView[];
    grid: GridView;
    objects: PlacedObject[];
  };
  editor?: {
    residents: ResidentConfig[];
    objectKinds: string[];
  };
  serverTime: number;
  time: SimTime;
  tick: number;
  running: boolean;
  speed: number;
  residents: ResidentView[];
  human: HumanView;
  events: VilleEvent[];
  llm: LLMStats;
}
