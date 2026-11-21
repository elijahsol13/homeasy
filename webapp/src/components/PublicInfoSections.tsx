import { ArrowRight, ArrowUpRight, Bookmark, MapPin, MessageCircle, Search } from 'lucide-react';
import '../public-sections.css';

export interface PublicInfoSectionsProps {
  onBrowse: () => void;
  onMap: () => void;
}

/** Editorial introduction for the public website. Render only in web mode. */
export function PublicInfoSections({ onBrowse, onMap }: PublicInfoSectionsProps) {
  return (
    <section id="about" className="public-site public-info-sections" aria-labelledby="public-info-title">
      <div className="pi-container">
        <div className="pi-opening">
          <div className="pi-opening__copy">
            <p className="pi-eyebrow">
              <span className="pi-eyebrow__spark" aria-hidden="true">✳</span>
              A BETTER WAY TO LOOK AROUND
            </p>
            <h2 id="public-info-title" className="pi-opening__title">
              A place to land.<br />
              <em>A space to begin.</em>
            </h2>
            <p className="pi-opening__description">
              Finding somewhere to live should feel like possibility, not a pile of open tabs.
              Browse rental advertisements, explore the neighbourhood and make your own shortlist.
            </p>
            <div className="pi-actions">
              <button type="button" className="pi-button pi-button--primary" onClick={onBrowse}>
                Browse homes <ArrowUpRight size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button type="button" className="pi-button pi-button--text" onClick={onMap}>
                Explore the map <ArrowRight size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
            <p className="pi-opening__footnote">Your search. Your shortlist. Your next move.</p>
          </div>

          <div className="pi-art" aria-hidden="true">
            <div className="pi-art__topline">
              <span>FIELD NOTES / 001</span>
              <span>SIEM REAP · CAMBODIA</span>
            </div>
            <div className="pi-art__scene">
              <span className="pi-art__contour pi-art__contour--one" />
              <span className="pi-art__contour pi-art__contour--two" />
              <span className="pi-art__contour pi-art__contour--three" />
              <span className="pi-art__contour pi-art__contour--four" />
              <span className="pi-art__location"><MapPin size={38} strokeWidth={1.5} /></span>
              <span className="pi-art__coordinate">13° N / 103° E</span>
            </div>
            <div className="pi-art__bottomline">
              <span>THE ART OF FEELING AT HOME</span>
              <span className="pi-art__asterisk">✳</span>
            </div>
            <div className="pi-art__side-label">A NEW CHAPTER STARTS SOMEWHERE</div>
          </div>
        </div>

        <div className="pi-process" aria-labelledby="public-process-title">
          <div className="pi-process__heading">
            <div>
              <p className="pi-eyebrow pi-eyebrow--quiet">HOW HOMEASY WORKS</p>
              <h3 id="public-process-title">From first look <em>to first hello.</em></h3>
            </div>
            <p>Three simple steps, with you in control all the way.</p>
          </div>

          <ol className="pi-steps">
            <li className="pi-step pi-step--first">
              <div className="pi-step__top">
                <span className="pi-step__number">01 / DISCOVER</span>
                <span className="pi-step__icon"><Search size={22} strokeWidth={1.65} aria-hidden="true" /></span>
              </div>
              <div className="pi-step__content">
                <h4>Find what feels right.</h4>
                <p>Browse listings from public advertisements. Search and filter by the details that matter to you.</p>
              </div>
              <span className="pi-step__line" aria-hidden="true" />
              <span className="pi-step__tail">START WITH THE POSSIBILITIES</span>
            </li>
            <li className="pi-step pi-step--second">
              <div className="pi-step__top">
                <span className="pi-step__number">02 / EXPLORE</span>
                <span className="pi-step__icon"><Bookmark size={22} strokeWidth={1.65} aria-hidden="true" /></span>
              </div>
              <div className="pi-step__content">
                <h4>Get a sense of place.</h4>
                <p>See locations on the map where available, and save interesting homes to revisit in this browser.</p>
              </div>
              <span className="pi-step__line" aria-hidden="true" />
              <span className="pi-step__tail">MAKE A SHORTLIST OF YOUR OWN</span>
            </li>
            <li className="pi-step pi-step--third">
              <div className="pi-step__top">
                <span className="pi-step__number">03 / CONNECT</span>
                <span className="pi-step__icon"><MessageCircle size={22} strokeWidth={1.65} aria-hidden="true" /></span>
              </div>
              <div className="pi-step__content">
                <h4>Take the next step.</h4>
                <p>Use the contact options on a listing to check details, availability and viewing arrangements directly with the advertiser.</p>
              </div>
              <span className="pi-step__line" aria-hidden="true" />
              <span className="pi-step__tail">THE CONVERSATION IS YOURS</span>
            </li>
          </ol>
        </div>

        <aside className="pi-source-note" aria-label="A note about listing information">
          <span className="pi-source-note__mark" aria-hidden="true">i</span>
          <div>
            <h3>A note on the details</h3>
            <p>
              Homeasy brings together rental advertisements from third-party sources. We do not independently
              verify every listing, and prices, availability, locations or contact details may change.
              Please confirm the information with the advertiser before making arrangements or payments.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
