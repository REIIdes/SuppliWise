import './DeferredPlanSection.css';

/**
 * The doses of a plan that are not today's rows, listed as a start.
 *
 * A plan made at 3 PM has a Morning stack whose window shut at noon, and the
 * server does not write those frames into today at all
 * (server/utils/todayPlanSync.js). Hiding them would leave the user wondering
 * where half their plan went; showing them among today's doses would ask them to
 * take a pill for a window that has closed. So they get their own read-only
 * section, headed by the reset that turns them into ordinary work.
 *
 * Nothing here is tickable, and nothing here is red. That is the whole point of
 * the block: these doses are neither done nor missed, they simply have not
 * started. Renders nothing on every day that is not a plan's first.
 *
 * @param {{view: ReturnType<typeof import('../utils/planDeferred.js').deferredPlanView>}} props
 *   `view` is computed by the page, which also needs to know whether anything is
 *   deferred at all: a plan whose only doses start tomorrow has no rows today, and
 *   that is not the "you have no supplements" empty state.
 */
export default function DeferredPlanSection({ view }) {
  if (!view || !view.active) return null;

  return (
    <section
      className="deferred-plan"
      aria-labelledby="deferred-plan-heading"
      data-testid="deferred-plan-section"
    >
      <header className="deferred-plan__header">
        <span className="deferred-plan__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
        </span>
        <span className="deferred-plan__names">
          <h3 id="deferred-plan-heading" className="deferred-plan__title">
            Starts {view.startsLabel}
          </h3>
          <span className="deferred-plan__note">{view.text}</span>
        </span>
        <span className="deferred-plan__count">{view.count}</span>
      </header>

      {view.groups.map((group) => (
        <div className={`deferred-plan__frame deferred-plan__frame--${group.key}`} key={group.key}>
          <p className="deferred-plan__frame-head">
            {group.label}
            {group.window && <span className="deferred-plan__window">{group.window}</span>}
          </p>
          <ul className="deferred-plan__list">
            {group.items.map((item) => (
              <li className="deferred-plan__item" key={`${group.key}-${item.name}`}>
                <span
                  className={`deferred-plan__dot deferred-plan__dot--${String(item.priority || 'Medium').toLowerCase()}`}
                  title={`${item.priority || 'Medium'} Priority`}
                >
                  <svg width="6" height="6" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="12" />
                  </svg>
                </span>
                <span className="deferred-plan__name">{item.name}</span>
                {item.dosage && <span className="deferred-plan__dosage">{item.dosage}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
