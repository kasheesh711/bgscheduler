import { useEffect, useState } from "react";

export function useMinute() {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000));
  useEffect(() => {
    let timer: number;
    function schedule() {
      timer = window.setTimeout(() => {
        setMinute(Math.floor(Date.now() / 60000));
        schedule();
      }, 60000 - (Date.now() % 60000));
    }
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return minute;
}
