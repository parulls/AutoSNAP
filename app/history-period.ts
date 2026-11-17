export type Period="today"|"week"|"month"|"custom";
export type HistoryRange={period:Period;from:string;to:string};
export function rangeForPeriod(period:Exclude<Period,"custom">,now=new Date()):HistoryRange{
  const jakarta=new Date(now.getTime()+7*3600000),to=jakarta.toISOString().slice(0,10);
  const first=new Date(`${to}T00:00:00Z`);
  if(period==="week")first.setUTCDate(first.getUTCDate()-((first.getUTCDay()+6)%7));
  if(period==="month")first.setUTCDate(1);
  // Current week/month includes its complete calendar range, not a rolling duration.
  let end=to;
  if(period==="week"){const sunday=new Date(first);sunday.setUTCDate(sunday.getUTCDate()+6);end=sunday.toISOString().slice(0,10);}
  if(period==="month")end=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).toISOString().slice(0,10);
  return {period,from:first.toISOString().slice(0,10),to:end};
}
