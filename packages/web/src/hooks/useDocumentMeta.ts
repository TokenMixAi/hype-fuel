import {useEffect} from "react";
import {useLocation} from "react-router-dom";

import {ROUTES, SITE_URL} from "../content/site";

function setMeta(selector: string, attribute: string, content: string) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute(attribute, content);
}

/**
 * Keeps the title, description and canonical URL in step with the current route.
 *
 * `index.html` already ships correct tags for a cold load, which is what crawlers and social
 * unfurlers see. This exists for everything after that: a client-side navigation changes no markup
 * on its own, so without it every route would share the landing page's title in the tab, in the
 * history dropdown and in a bookmark.
 *
 * Unknown paths get `noindex` and a canonical pointing at the root. A static site cannot answer
 * with a real 404 status, and the router falls through to the landing page, so otherwise every
 * typo'd URL would look like a duplicate of the homepage.
 */
export function useDocumentMeta() {
  const {pathname} = useLocation();

  useEffect(() => {
    const path = pathname.replace(/\/+$/, "") || "/";
    const route = ROUTES.find((candidate) => candidate.path === path);

    document.title = route ? route.title : "Page not found | HypeFuel";

    if (route) {
      setMeta('meta[name="description"]', "content", route.description);
      setMeta('meta[name="robots"]', "content", "index, follow, max-image-preview:large");
      setMeta("link[data-seo-canonical]", "href", `${SITE_URL}${path === "/" ? "/" : path}`);
    } else {
      setMeta('meta[name="robots"]', "content", "noindex, follow");
      setMeta("link[data-seo-canonical]", "href", `${SITE_URL}/`);
    }
  }, [pathname]);
}
