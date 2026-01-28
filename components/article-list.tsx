"use client"

import { cn } from "@/lib/utils"
import { Article } from "@/lib/rss-data"
import { Star, Circle } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"

interface ArticleListProps {
  articles: Article[]
  selectedArticle: Article | null
  onSelectArticle: (article: Article) => void
}

export function ArticleList({ articles, selectedArticle, onSelectArticle }: ArticleListProps) {
  if (articles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 animate-fade-in">
        <div className="text-center">
          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-5">
            <Circle className="w-10 h-10 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">No articles</h3>
          <p className="text-base text-muted-foreground">Add feeds to start reading</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-3 space-y-2">
        {articles.map((article, index) => (
          <ArticlePreview
            key={article.id}
            article={article}
            isSelected={selectedArticle?.id === article.id}
            onClick={() => onSelectArticle(article)}
            index={index}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

function ArticlePreview({
  article,
  isSelected,
  onClick,
  index,
}: {
  article: Article
  isSelected: boolean
  onClick: () => void
  index: number
}) {
  return (
    <article
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index * 50, 300)}ms` }}
      className={cn(
        "p-4 cursor-pointer rounded-2xl transition-all duration-300 ease-out group animate-fade-in-up",
        "hover:scale-[1.01] active:scale-[0.99]",
        isSelected
          ? "bg-accent/10 ring-1 ring-accent/20 shadow-lg shadow-accent/5"
          : "hover:bg-muted/60 hover:shadow-md",
        !article.isRead && "bg-card shadow-sm"
      )}
    >
      <div className="flex gap-4">
        {/* Large Image */}
        {article.imageUrl && (
          <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-xl overflow-hidden flex-shrink-0 bg-muted relative group-hover:shadow-lg transition-shadow duration-300">
            <img
              src={article.imageUrl || "/placeholder.svg"}
              alt=""
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {!article.isRead && (
              <div className="absolute top-2 left-2 w-2.5 h-2.5 rounded-full bg-accent animate-pulse-gentle" />
            )}
          </div>
        )}
        
        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          {/* Feed Info */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{article.feedIcon}</span>
            <span className="text-sm font-medium text-muted-foreground">{article.feedName}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-sm text-muted-foreground">{article.publishedAt}</span>
            {article.isStarred && (
              <Star className="w-4 h-4 text-amber-500 fill-amber-500 ml-auto transition-transform duration-300 group-hover:scale-110" />
            )}
          </div>
          
          {/* Title */}
          <h3 className={cn(
            "text-lg leading-snug mb-2 line-clamp-2 text-balance transition-colors duration-200",
            !article.isRead 
              ? "font-semibold text-foreground" 
              : "font-medium text-foreground/75"
          )}>
            {article.title}
          </h3>
          
          {/* Excerpt */}
          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed mb-3">
            {article.excerpt}
          </p>
          
          {/* Footer */}
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="font-medium">{article.author}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{article.readTime}</span>
          </div>
        </div>
      </div>
    </article>
  )
}
