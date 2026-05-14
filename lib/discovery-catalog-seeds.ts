export const SEED_FEEDS = [
  // Tech
  { url: "https://news.ycombinator.com/rss", title: "Hacker News", description: "Tech news and discussion", category: "tech", language: "en", popularity: 100 },
  { url: "https://www.theverge.com/rss/index.xml", title: "The Verge", description: "Technology, science, art, and culture", category: "tech", language: "en", popularity: 95 },
  { url: "https://techcrunch.com/feed/", title: "TechCrunch", description: "Startup and technology news", category: "tech", language: "en", popularity: 90 },
  { url: "https://www.wired.com/feed/rss", title: "Wired", description: "Tech, science, culture, and business", category: "tech", language: "en", popularity: 85 },
  { url: "https://arstechnica.com/feed/", title: "Ars Technica", description: "Tech news and analysis", category: "tech", language: "en", popularity: 88 },
  { url: "https://www.heise.de/rss/heise-atom.xml", title: "Heise Online", description: "IT-News und Technik", category: "tech", language: "de", popularity: 80 },
  { url: "https://www.golem.de/rss.php?feed=RSS2.0", title: "Golem.de", description: "IT-News für Profis", category: "tech", language: "de", popularity: 75 },

  // News
  { url: "https://feeds.bbci.co.uk/news/rss.xml", title: "BBC News", description: "World news from BBC", category: "news", language: "en", popularity: 100 },
  { url: "https://www.theguardian.com/international/rss", title: "The Guardian", description: "International news and opinion", category: "news", language: "en", popularity: 95 },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", title: "New York Times", description: "Breaking news and analysis", category: "news", language: "en", popularity: 90 },
  { url: "https://feeds.reuters.com/reuters/topNews", title: "Reuters", description: "International news agency", category: "news", language: "en", popularity: 88 },
  { url: "https://www.spiegel.de/schlagzeilen/tops/index.rss", title: "Spiegel Online", description: "Nachrichten aus Deutschland", category: "news", language: "de", popularity: 85 },
  { url: "https://www.tagesschau.de/xml/rss2/", title: "Tagesschau", description: "Nachrichten der ARD", category: "news", language: "de", popularity: 90 },

  // Dev
  { url: "https://css-tricks.com/feed/", title: "CSS-Tricks", description: "Web development tips and tricks", category: "dev", language: "en", popularity: 90 },
  { url: "https://dev.to/feed", title: "DEV Community", description: "Developer community articles", category: "dev", language: "en", popularity: 85 },
  { url: "https://www.smashingmagazine.com/feed/", title: "Smashing Magazine", description: "Web design and development", category: "dev", language: "en", popularity: 88 },
  { url: "https://changelog.com/feed", title: "The Changelog", description: "Open source and software development", category: "dev", language: "en", popularity: 80 },
  { url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog", description: "Official Rust programming language blog", category: "dev", language: "en", popularity: 75 },
  { url: "https://react.dev/rss.xml", title: "React Blog", description: "Official React framework blog", category: "dev", language: "en", popularity: 82 },

  // Science
  { url: "https://www.nasa.gov/rss/dyn/breaking_news.rss", title: "NASA Breaking News", description: "Space exploration news", category: "science", language: "en", popularity: 95 },
  { url: "https://www.quantamagazine.org/feed/", title: "Quanta Magazine", description: "Science and mathematics journalism", category: "science", language: "en", popularity: 90 },
  { url: "https://www.scientificamerican.com/feed/", title: "Scientific American", description: "Science news and discoveries", category: "science", language: "en", popularity: 85 },
  { url: "https://www.nature.com/nature.rss", title: "Nature", description: "Scientific research journal", category: "science", language: "en", popularity: 88 },

  // Business
  { url: "https://www.economist.com/finance-and-economics/rss.xml", title: "The Economist - Finance", description: "Finance and economics news", category: "business", language: "en", popularity: 90 },
  { url: "https://feeds.bloomberg.com/markets/news.rss", title: "Bloomberg Markets", description: "Financial markets news", category: "business", language: "en", popularity: 85 },
  { url: "https://www.ft.com/rss/home", title: "Financial Times", description: "Business and financial news", category: "business", language: "en", popularity: 88 },

  // Gaming
  { url: "https://kotaku.com/rss", title: "Kotaku", description: "Gaming news and reviews", category: "gaming", language: "en", popularity: 90 },
  { url: "https://www.polygon.com/rss/index.xml", title: "Polygon", description: "Gaming and entertainment", category: "gaming", language: "en", popularity: 85 },
  { url: "https://www.ign.com/rss/articles", title: "IGN", description: "Video games, movies, TV", category: "gaming", language: "en", popularity: 88 },
  { url: "https://www.rockpapershotgun.com/feed", title: "Rock Paper Shotgun", description: "PC gaming news", category: "gaming", language: "en", popularity: 80 },

  // Design
  { url: "https://alistapart.com/main/feed/", title: "A List Apart", description: "Web design and development", category: "design", language: "en", popularity: 85 },
  { url: "https://uxdesign.cc/feed", title: "UX Collective", description: "User experience design", category: "design", language: "en", popularity: 80 },
  { url: "https://www.nngroup.com/feed/rss/", title: "Nielsen Norman Group", description: "UX research and consulting", category: "design", language: "en", popularity: 88 },

  // Entertainment
  { url: "https://www.hollywoodreporter.com/feed/", title: "Hollywood Reporter", description: "Entertainment industry news", category: "entertainment", language: "en", popularity: 85 },
  { url: "https://variety.com/feed/", title: "Variety", description: "Entertainment news", category: "entertainment", language: "en", popularity: 83 },

  // Sports
  { url: "https://www.espn.com/espn/rss/news", title: "ESPN", description: "Sports news and scores", category: "sports", language: "en", popularity: 90 },
  { url: "https://www.kicker.de/rss/news", title: "Kicker", description: "Fußball und Sport", category: "sports", language: "de", popularity: 85 },

  // Lifestyle
  { url: "https://lifehacker.com/rss", title: "Lifehacker", description: "Tips and tricks for life", category: "lifestyle", language: "en", popularity: 80 },
  { url: "https://www.apartmenttherapy.com/main.rss", title: "Apartment Therapy", description: "Home and design inspiration", category: "lifestyle", language: "en", popularity: 75 },
] as const;

export type SeedFeed = (typeof SEED_FEEDS)[number];
