import type { MouseEvent } from 'react';
import { ArrowRight, ArrowUpRight, Compass, Heart, MapPinned } from 'lucide-react';
import '../public-sections.css';

export interface PublicFooterProps {
  onBrowse: () => void;
  onMap: () => void;
  onSaved: () => void;
}

function navigateOnPlainClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

/** Footer navigation for the public website. Render only in web mode. */
export function PublicFooter({ onBrowse, onMap, onSaved }: PublicFooterProps) {
  return (
    <footer className="public-site public-footer">
      <div className="pf-container">
        <div className="pf-lead">
          <div className="pf-identity">
            <a className="pf-logo" href="/" aria-label="Homeasy — home">
              <span className="pf-logo__symbol" aria-hidden="true">✳</span>
              homeasy<span className="pf-logo__dot">.</span>
            </a>
            <p>A little less searching.<br />A little more living.</p>
          </div>
          <div className="pf-invitation">
            <span className="pf-kicker">YOUR NEXT CHAPTER</span>
            <p>Somewhere new<br /><em>starts here.</em></p>
            <a href="/#listings" className="pf-cta" onClick={(event) => navigateOnPlainClick(event, onBrowse)}>
              Explore the listings <ArrowUpRight size={19} strokeWidth={1.8} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="pf-middle">
          <nav className="pf-navigation" aria-label="Footer navigation">
            <h2>EXPLORE</h2>
            <div className="pf-navigation__links">
              <a href="/#listings" onClick={(event) => navigateOnPlainClick(event, onBrowse)}><Compass size={18} aria-hidden="true" /> Browse homes</a>
              <a href="/map" onClick={(event) => navigateOnPlainClick(event, onMap)}><MapPinned size={18} aria-hidden="true" /> View map</a>
              <a href="/saved" onClick={(event) => navigateOnPlainClick(event, onSaved)}><Heart size={18} aria-hidden="true" /> Saved homes</a>
            </div>
          </nav>
          <div className="pf-disclaimer">
            <h2>GOOD TO KNOW</h2>
            <p>
              Homeasy displays property advertisements from external sources.
              Details may be incomplete or outdated. Please verify them with the advertiser directly.
            </p>
          </div>
        </div>

        <div className="pf-bottom">
          <span>© {new Date().getFullYear()} Homeasy</span>
          <span>Made for the search, wherever it takes you.</span>
          <a href="/privacy">Privacy &amp; analytics <ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </div>
    </footer>
  );
}
