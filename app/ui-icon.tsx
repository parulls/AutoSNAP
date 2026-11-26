import type { SVGProps } from "react";

const paths = {
  data: "M4 7h16M4 12h16M4 17h16M7 4v16M17 4v16M4 4h16v16H4z",
  testing: "m9 5 10 7-10 7V5Z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  logout: "M9 21H4V3h5M14 8l5 4-5 4M8 12h11",
  shield: "m12 3 8 4v6c0 5-8 8-8 8s-8-3-8-8V7l8-4Zm-4 9 3 3 5-6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  close: "m6 6 12 12M6 18 18 6",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "m3 3 18 18M10.6 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-2.1 2.8M6.2 6.2C3.4 8 2 12 2 12s3.5 6 10 6c1 0 1.9-.1 2.7-.4M9.9 9.9a3 3 0 0 0 4.2 4.2",
  dashboard: "M4 4h6v6H4V4Zm10 0h6v10h-6V4ZM4 14h6v6H4v-6Zm10 4h6v2h-6v-2Z",
  simulator: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5l-2 3-2-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 5 3 3-3 3m5 0h5",
  menu: "M4 6h16M4 12h16M4 18h16",
  refresh: "M20 11a8 8 0 1 0 2 5M20 4v7h-7",
  chevronDown: "m6 9 6 6 6-6",
};

export default function UiIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
