"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return <div className="w-9 h-9" />;

  const toggleTheme = () => {
    if (theme === "dark") setTheme("system");
    else if (theme === "system") setTheme("light");
    else setTheme("dark");
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="w-9 h-9 relative overflow-hidden transition-all duration-300 hover:bg-black/35 dark:hover:bg-white/10 active:scale-95 rounded-xl"
      onClick={toggleTheme}
    >
      <div className="relative h-4 w-4">
        <Sun
          className={`absolute inset-0 h-4 w-4 transition-all duration-500 ${theme === "light" ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-0 opacity-0"}`}
        />
        <Moon
          className={`absolute inset-0 h-4 w-4 transition-all duration-500 ${theme === "dark" ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0"}`}
        />
        <Monitor
          className={`absolute inset-0 h-4 w-4 transition-all duration-500 ${theme === "system" ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-0 opacity-0"}`}
        />
      </div>
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
