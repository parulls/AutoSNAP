"use client";

import { useState, type InputHTMLAttributes } from "react";
import UiIcon from "./ui-icon";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export default function PasswordInput(props: Props) {
  const [visible, setVisible] = useState(false);
  return <span className="password-input">
    <input {...props} type={visible ? "text" : "password"}/>
    <button
      type="button"
      className="password-toggle"
      aria-label={visible ? "Sembunyikan password" : "Tampilkan password"}
      aria-pressed={visible}
      title={visible ? "Sembunyikan password" : "Tampilkan password"}
      onClick={() => setVisible(current => !current)}
      disabled={props.disabled}
    ><UiIcon name={visible ? "eyeOff" : "eye"}/></button>
  </span>;
}
