export interface FeedSource {
  id: string
  name: string
  url: string
  icon: string
  category: string
  categoryId?: string | null
  unreadCount: number
}

export interface Article {
  id: string
  feedId: string
  feedName: string
  feedIcon: string
  title: string
  link: string
  excerpt: string
  content: string
  author: string
  publishedAt: string
  publishedAtRaw?: number
  readTime: string
  isRead: boolean
  readAt?: string | Date | null
  isStarred: boolean
  isReadLater: boolean
  readLaterSavedAt?: string | Date | null
  isSpoiler?: boolean
  imageUrl?: string
  isDuplicate?: boolean
  duplicateOf?: string | null
  duplicateCount?: number
  canonicalFeedName?: string | null
  aiSummary?: string | null
  aiSummarizedAt?: string | Date | null
  labels?: Array<{
    label: {
      id: string
      name: string
      color: string
    }
  }>
}

export const feedSources: FeedSource[] = [
  { id: "1", name: "The Verge", url: "theverge.com", icon: "📱", category: "Technology", unreadCount: 12 },
  { id: "2", name: "Wired", url: "wired.com", icon: "⚡", category: "Technology", unreadCount: 8 },
  { id: "3", name: "TechCrunch", url: "techcrunch.com", icon: "🚀", category: "Technology", unreadCount: 15 },
  { id: "4", name: "Ars Technica", url: "arstechnica.com", icon: "🔬", category: "Technology", unreadCount: 6 },
  { id: "5", name: "Hacker News", url: "news.ycombinator.com", icon: "💻", category: "Technology", unreadCount: 23 },
  { id: "6", name: "Design Milk", url: "design-milk.com", icon: "🎨", category: "Design", unreadCount: 4 },
  { id: "7", name: "Dezeen", url: "dezeen.com", icon: "🏛️", category: "Design", unreadCount: 7 },
  { id: "8", name: "Smashing Magazine", url: "smashingmagazine.com", icon: "✨", category: "Design", unreadCount: 3 },
]

export const articles: Article[] = [
  {
    id: "1",
    feedId: "1",
    feedName: "The Verge",
    feedIcon: "📱",
    link: "https://example.com/apple-vision-pro-2",
    title: "Apple unveils Vision Pro 2 with breakthrough spatial computing features",
    excerpt: "The next generation of Apple's mixed reality headset brings significant improvements to display technology, battery life, and developer tools.",
    content: `Apple today announced Vision Pro 2, the successor to its groundbreaking spatial computing device. The new headset features micro-OLED displays with 8K resolution per eye, representing a 60% increase in pixel density over the original model.

The company emphasized improvements to the device's comfort, reducing weight by 25% through the use of new carbon fiber materials. Battery life has been extended to 4 hours of continuous use, up from 2 hours in the first generation.

"Vision Pro 2 represents our vision for the future of personal computing," said Tim Cook during the announcement. "We've listened to our customers and developers, and we're excited to deliver an experience that's more immersive, more comfortable, and more capable than ever before."

New developer tools include improved hand tracking, eye tracking accuracy improvements, and a new spatial audio system that creates even more realistic soundscapes. The device also features a new "Persona" system that creates more lifelike digital avatars for video calls.

Pricing starts at $2,999 for the 256GB model, with availability beginning next month.`,
    author: "Sarah Chen",
    publishedAt: "2 hours ago",
    readTime: "4 min read",
    isRead: false,
    isStarred: true,
    isReadLater: false,
    imageUrl: "https://images.unsplash.com/photo-1617802690992-15d93263d3a9?w=800&q=80"
  },
  {
    id: "2",
    feedId: "2",
    feedName: "Wired",
    feedIcon: "⚡",
    link: "https://example.com/ai-revolution-work",
    title: "The AI revolution is reshaping how we work, create, and think",
    excerpt: "From coding assistants to creative tools, artificial intelligence is transforming every aspect of knowledge work in ways we're only beginning to understand.",
    content: `The integration of AI into daily workflows has accelerated dramatically over the past year. What started as experimental chatbots has evolved into sophisticated systems that can write code, create art, analyze data, and even engage in complex reasoning tasks.

For software developers, AI coding assistants have become indispensable. Studies show that developers using these tools complete tasks 55% faster on average, with comparable code quality to human-written solutions.

But the impact extends far beyond tech. Marketing teams use AI to generate campaign ideas and analyze customer sentiment. Researchers employ AI to sift through thousands of papers and identify relevant findings. Writers collaborate with AI to overcome creative blocks and explore new narrative possibilities.

Critics argue that this reliance on AI could erode human skills and creativity. Proponents counter that AI is simply the latest in a long line of tools that augment human capability—from the printing press to the calculator.

What's clear is that the nature of work is changing. The most successful professionals of the future may be those who can effectively collaborate with AI, knowing when to leverage its capabilities and when to trust their own judgment.`,
    author: "Michael Torres",
    publishedAt: "5 hours ago",
    readTime: "6 min read",
    isRead: false,
    isStarred: false,
    isReadLater: false,
    imageUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&q=80"
  },
  {
    id: "3",
    feedId: "3",
    feedName: "TechCrunch",
    feedIcon: "🚀",
    link: "https://example.com/modular-motors-series-b",
    title: "Startup raises $50M to build the next generation of electric vehicles",
    excerpt: "The funding round was led by Sequoia Capital and will help the company scale production of its innovative modular EV platform.",
    content: `Modular Motors, a startup focused on customizable electric vehicles, has raised $50 million in Series B funding led by Sequoia Capital with participation from existing investors a16z and Khosla Ventures.

The company's unique approach allows customers to configure their vehicles with interchangeable modules for battery capacity, cargo space, and seating arrangements. A single base platform can transform from a compact city car to a delivery van in under an hour.

"We believe the future of transportation is personalized and adaptable," said CEO Maria Gonzalez. "Our platform gives consumers the flexibility to own one vehicle that meets all their needs, rather than multiple specialized ones."

The funding will be used to expand manufacturing capacity at the company's Nevada facility, which currently produces 500 vehicles per month. The goal is to reach 5,000 monthly units by the end of next year.

Industry analysts are watching closely. If Modular Motors can deliver on its promises, it could disrupt not just the automotive industry but the entire concept of vehicle ownership.`,
    author: "James Park",
    publishedAt: "8 hours ago",
    readTime: "3 min read",
    isRead: true,
    isStarred: false,
    isReadLater: false,
    imageUrl: "https://images.unsplash.com/photo-1593941707882-a5bba14938c7?w=800&q=80"
  },
  {
    id: "4",
    feedId: "5",
    feedName: "Hacker News",
    feedIcon: "💻",
    link: "https://example.com/rust-systems-programming",
    title: "Why Rust is becoming the language of choice for systems programming",
    excerpt: "Memory safety guarantees without garbage collection are attracting developers from C and C++ to this modern systems language.",
    content: `Rust has seen explosive growth in adoption over the past year, with major tech companies including Microsoft, Google, and Amazon integrating it into critical infrastructure projects.

The language's appeal lies in its ability to prevent entire categories of bugs at compile time. Buffer overflows, use-after-free errors, and data races—common vulnerabilities in C and C++—are essentially impossible in safe Rust code.

"We've reduced our security vulnerability count by 70% since migrating our networking stack to Rust," reported a senior engineer at a major cloud provider. "The initial learning curve was steep, but the long-term benefits have been enormous."

The Rust ecosystem has also matured significantly. Frameworks for web development, embedded systems, and even game development now rival their counterparts in more established languages.

Critics note that Rust's complexity can slow development speed and that its strict compiler can frustrate newcomers. But for projects where reliability and performance are paramount, Rust has become an increasingly compelling choice.`,
    author: "Alex Kim",
    publishedAt: "12 hours ago",
    readTime: "5 min read",
    isRead: false,
    isStarred: true,
    isReadLater: false,
  },
  {
    id: "5",
    feedId: "6",
    feedName: "Design Milk",
    feedIcon: "🎨",
    link: "https://example.com/minimalist-furniture-design",
    title: "Minimalism meets functionality in this year's best furniture designs",
    excerpt: "Scandinavian influences continue to dominate as designers embrace clean lines, natural materials, and timeless aesthetics.",
    content: `The Milan Furniture Fair revealed clear trends for the coming year: simplicity, sustainability, and craftsmanship. Designers are moving away from bold statements in favor of pieces that integrate seamlessly into living spaces.

Natural materials dominated the showroom floors. Oak, walnut, and ash appeared in everything from dining tables to bed frames. Metal accents were subtle—thin brass legs, brushed steel hardware—never overpowering the wood's natural beauty.

Color palettes skewed neutral. Warm whites, soft grays, and muted earth tones created calm, contemplative environments. When color did appear, it was often in textiles: a terracotta throw pillow, a sage green upholstered chair.

Modularity emerged as another key theme. Sofas with reconfigurable sections, shelving systems that adapt to different spaces, and desks with interchangeable components reflect the reality of modern living—where people move frequently and spaces serve multiple purposes.

"Good design should be invisible," said one prominent designer. "It should make life easier without demanding attention."`,
    author: "Emma Richardson",
    publishedAt: "1 day ago",
    readTime: "4 min read",
    isRead: true,
    isStarred: false,
    isReadLater: false,
    imageUrl: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80"
  },
  {
    id: "6",
    feedId: "4",
    feedName: "Ars Technica",
    feedIcon: "🔬",
    link: "https://example.com/quantum-error-correction",
    title: "Quantum computing milestone: First error-corrected calculations achieved",
    excerpt: "Researchers demonstrate practical quantum error correction, bringing fault-tolerant quantum computers closer to reality.",
    content: `A team of researchers at a leading quantum computing laboratory has achieved a significant milestone: performing calculations on a quantum processor with active error correction that actually improves outcomes rather than degrading them.

Quantum computers are notoriously fragile. The quantum bits (qubits) that store information are easily disrupted by environmental noise, leading to errors that accumulate rapidly. Error correction has long been seen as the key to practical quantum computing.

"For the first time, we've demonstrated that adding more physical qubits to correct errors actually results in better logical qubit performance," explained the lead researcher. "This has been the missing piece."

The experiment used a novel approach involving 72 physical qubits working together to create a single logical qubit. Error rates for the logical qubit were ten times lower than for any individual physical qubit—a dramatic improvement.

While practical applications remain years away, this breakthrough provides a clear path forward. Industry experts predict that error-corrected quantum computers capable of solving commercially relevant problems could arrive within the next decade.`,
    author: "David Chen",
    publishedAt: "1 day ago",
    readTime: "7 min read",
    isRead: false,
    isStarred: false,
    isReadLater: false,
    imageUrl: "https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=800&q=80"
  },
]

export const categories = ["All", "Technology", "Design", "Science", "Business"]
