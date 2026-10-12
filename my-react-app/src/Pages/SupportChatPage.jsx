import { useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import SupportInbox from '../Components/SupportInbox/SupportInbox';
import './SupportChatPage.css';

/**
 * SUPPORT — the page behind /support.
 *
 * Deliberately a thin shell: Navbar + the inbox. All of the state lives in
 * SupportInbox so the same component could be mounted somewhere else later
 * without dragging a page's worth of logic with it.
 *
 * `?topic=` preselects the category. That is what makes the pricing page's
 * "Talk to support" button useful: someone cancelling a plan because they paid
 * by transfer lands with "Payment" already chosen and the form open, instead of
 * a blank inbox they have to work out how to use.
 *
 * `?thread=<id>` opens ONE conversation directly. Every "Support replied to
 * your message" bell links here, so the member lands on the reply itself
 * instead of on the list, having to spot which of twenty threads it was.
 */
export default function SupportChatPage() {
  const [searchParams] = useSearchParams();
  // 'new=1' opens the composer straight away — set by the pricing page.
  const startComposing = searchParams.get('new') === '1';
  const topic = searchParams.get('topic') || 'payment';
  const thread = searchParams.get('thread') || '';

  return (
    <div className="support-page">
      <Navbar />
      <main className="support-page__main">
        <SupportInbox
          initialCategory={topic}
          startComposing={startComposing}
          focusThreadId={thread}
        />
      </main>
    </div>
  );
}
