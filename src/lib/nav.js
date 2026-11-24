// The whole CMS has four sections. Each section has tabs (groups) and, inside a tab, small pills.
// Every older screen is still reachable, it now lives inside one of these four.
export const SECTIONS = [
  {
    key: "dashboard", label: "Dashboard", icon: "📊", href: "/admin",
    groups: [
      { label: "Overview", items: [["/admin", "Overview"]] },
      { label: "Tracking & analytics", items: [["/admin/analytics", "Tracking & analytics"]] },
      { label: "Activity", items: [["/admin/activity", "Activity log"]] },
    ],
  },
  {
    key: "home", label: "Home", icon: "🏠", href: "/admin/r/blocks",
    groups: [
      { label: "Home page", items: [["/admin/r/blocks", "Website text"], ["/admin/r/lists", "Car lists"], ["/admin/r/compare", "Popular comparisons"], ["/admin/r/faqs", "Home FAQs"], ["/admin/r/reviews", "Owner reviews"]] },
      { label: "Header & footer", items: [["/admin/menus", "Menus"]] },
      { label: "Places & prices", items: [["/admin/r/cities", "Cities"], ["/admin/r/dealers", "Dealers"], ["/admin/r/fuel-prices", "Fuel prices"], ["/admin/r/fuel-stations", "Fuel stations"], ["/admin/r/ev-stations", "EV stations"]] },
      { label: "Settings", items: [["/admin/settings", "Site settings"], ["/admin/account", "My account"], ["/admin/users", "Users", "admin"], ["/admin/help", "Help"]] },
    ],
  },
  // All car data comes from CarScrapper. The old "Scraper" section (automotive-scraper service, VariantWise and
  // free-data imports) is switched off; its screens redirect here.
  {
    key: "carscraper", label: "CarScrapper", icon: "🕷️", href: "/admin/carscraper",
    groups: [
      { label: "Run & logs", items: [["/admin/carscraper", "Run scraper"]] },
      { label: "Saved cars", items: [["/admin/carscraper/cars", "Saved cars"]] },
      { label: "Website cars", items: [["/admin/cars", "All cars"], ["/admin/r/brands", "Brands"]] },
      { label: "Photos", items: [["/admin/media", "Photo library"]] },
      { label: "Schedule", items: [["/admin/carscraper/schedule", "Schedule"]] },
      { label: "Data", items: [["/admin/carscraper/data", "Data & quality"]] },
    ],
  },
  {
    key: "news", label: "News", icon: "📰", href: "/admin/articles",
    groups: [
      { label: "All news", items: [["/admin/articles", "All news & articles"]] },
      { label: "News inbox", items: [["/admin/news", "News inbox"]] },
      { label: "Topics", items: [["/admin/r/topics", "News topics"]] },
    ],
  },
  {
    key: "seo", label: "SEO", icon: "🔍", href: "/admin/seo",
    groups: [
      { label: "Pages", items: [["/admin/seo", "All pages"]] },
      { label: "Keywords", items: [["/admin/r/keywords", "Keywords"]] },
      { label: "Redirects", items: [["/admin/r/redirects", "Redirects"]] },
    ],
  },
  {
    key: "authors", label: "Authors", icon: "✍️", href: "/admin/authors",
    groups: [{ label: "Authors", items: [["/admin/authors", "Authors"]] }],
  },
];

const under = (path, href) => (href === "/admin" ? path === "/admin" || path === "/admin/" : path === href || path.startsWith(`${href}/`));

/** Finds the section, tab and pill for a URL path. Longest matching link wins. */
export function buildNav(path, user) {
  let best = null;
  for (const s of SECTIONS) {
    s.groups.forEach((g, gi) => g.items.forEach(([href]) => {
      if (under(path, href) && (!best || href.length > best.len)) best = { s, gi, href, len: href.length };
    }));
  }
  if (!best) best = { s: SECTIONS[0], gi: 0, href: "/admin", len: 0 };
  const isAdmin = user?.role === "admin";
  const groups = best.s.groups.map((g, i) => ({
    label: g.label,
    href: g.items[0][0],
    on: i === best.gi,
    items: g.items.filter((it) => !it[2] || (it[2] === "admin" && isAdmin)).map(([href, label]) => ({ href, label, on: href === best.href })),
  }));
  return { sections: SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: s.icon, href: s.href, on: s.key === best.s.key })), groups, current: best.s };
}
