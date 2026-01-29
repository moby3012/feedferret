"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const toggleTheme = () => {
    if (theme === "dark") setTheme("system");
    else if (theme === "system") setTheme("light");
    else setTheme("dark");
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="w-9 h-9 relative overflow-hidden transition-all duration-300 hover:bg-muted active:scale-95"
      onClick={toggleTheme}
    >
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all duration-500 dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all duration-500 dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
