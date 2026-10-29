import type { SimTime } from '../types.ts';

export function toMinutes(t: SimTime): number {
  return (t.day - 1) * 1440 + t.hour * 60 + t.minute;
}

export function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function hhmm(t: SimTime): string {
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

export function label(t: SimTime): string {
  return `Day ${t.day} ${hhmm(t)}`;
}

export function partOfDay(hour: number): string {
  if (hour < 5) return 'late night';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

/** True when `hour` falls inside a sleep window that may wrap past midnight. */
export function isSleepTime(hour: number, wake: number, sleep: number): boolean {
  if (wake === sleep) return false;
  if (wake < sleep) return hour >= sleep || hour < wake;
  return hour >= sleep && hour < wake;
}

export class Clock {
  time: SimTime;

  constructor(startHour: number, time?: SimTime) {
    this.time = time ?? { day: 1, hour: Math.floor(startHour), minute: Math.round((startHour % 1) * 60) };
  }

  advance(minutes: number): SimTime {
    let total = this.time.hour * 60 + this.time.minute + minutes;
    let day = this.time.day;
    while (total >= 1440) {
      total -= 1440;
      day++;
    }
    this.time = { day, hour: Math.floor(total / 60), minute: total % 60 };
    return this.time;
  }

  get now(): SimTime {
    return { ...this.time };
  }
}
