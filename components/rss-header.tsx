"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { 
  PanelLeft, 
  RefreshCw, 
  LayoutGrid, 
  List,
  SortAsc,
  Filter,
  MoreHorizontal
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ThemeToggle } from "@/components/theme-toggle"

interface RssHeaderProps {
  title: string
  articleCount: number
  viewMode: "list" | "grid"
  onViewModeChange: (mode: "list" | "grid") => void
  onToggleSidebar: () => void
  onRefresh: () => void
  isRefreshing?: boolean
}

export function RssHeader({
  title,
  articleCount,
  viewMode,
  onViewModeChange,
  onToggleSidebar,
  onRefresh,
  isRefreshing,
}: RssHeaderProps) {
  return (
    <header className="h-16 flex items-center justify-between px-5 border-b border-border bg-card/80 backdrop-blur-xl animate-fade-in">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl lg:hidden transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={onToggleSidebar}
        >
          <PanelLeft className="w-5 h-5" />
        </Button>
        <div>
          <h2 className="text-lg font-bold text-foreground tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{articleCount} articles</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={cn("w-5 h-5 transition-transform duration-500", isRefreshing && "animate-spin")} />
        </Button>

        <div className="hidden sm:flex items-center border border-border rounded-xl p-1 bg-muted/50">
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon"
            className="w-8 h-8 rounded-lg transition-all duration-200"
            onClick={() => onViewModeChange("list")}
          >
            <List className="w-4 h-4" />
          </Button>
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon"
            className="w-8 h-8 rounded-lg transition-all duration-200"
            onClick={() => onViewModeChange("grid")}
          >
            <LayoutGrid className="w-4 h-4" />
          </Button>
        </div>

        <div className="lg:hidden">
          <ThemeToggle />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="w-10 h-10 rounded-xl transition-all duration-200 hover:scale-105 active:scale-95">
              <MoreHorizontal className="w-5 h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 rounded-xl p-2">
            <DropdownMenuItem className="rounded-lg py-2.5 text-base">
              <SortAsc className="w-5 h-5 mr-3" />
              Sort by date
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg py-2.5 text-base">
              <Filter className="w-5 h-5 mr-3" />
              Filter unread
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="rounded-lg py-2.5 text-base">Mark all as read</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
