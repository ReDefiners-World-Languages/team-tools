#!/usr/bin/env python3
"""Turn raw tabs from Marketing_Unified_Database_Backend into dashboards/marketing-funnel-performance/data.json.

Usage: transform.py RAW_DIR OUT_JSON [--previous PREVIOUS_JSON] [--mcp-tab TAB_NAME]

--mcp-tab picks which sheet tab feeds the Enrollments view (default MCP_Enrollment_Data). Use MCP_Enrollment_Data_SF once the
Salesforce tab is complete; the shrink check below refuses it while it has fewer rows than the tab it replaces.

RAW_DIR holds one <tab name>.json per tab: the sheet's values as a list of rows, header row first.
This file is public, so the output only carries the fields the dashboard draws. Never add personal data:
feedback forms, parent contacts, staff "Created By" names and free-text notes stay out on purpose.
The check at the end refuses to overwrite good data with a short or stale pull (exit code 2).
"""
import json, os, re, sys, datetime as dt
from collections import Counter

MIN_LOCATION_ACTIVITIES = 3   # rarer outreach locations are folded into "Other locations" (free text, can name people)


def num(v):
    s = str(v if v is not None else '').strip().replace(',', '').replace('$', '').replace('%', '')
    if s in ('', '-', '--', 'NaN', 'nan', '#N/A', '#DIV/0!'):
        return 0
    try:
        f = float(s)
    except ValueError:
        return 0
    return int(f) if f == int(f) else round(f, 4)


def iso(v):
    s = str(v or '').strip()
    if not s or s == '-':
        return ''
    for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%b %d, %Y', '%Y%m%d'):
        try:
            return dt.datetime.strptime(s[:10] if fmt == '%Y-%m-%d' else s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return ''


def text(v):
    s = str(v if v is not None else '').strip()
    return '' if s == '-' else s


class Tab:
    def __init__(self, rows):
        self.header = [h.strip() for h in rows[0]]
        self.rows = rows[1:]

    def col(self, name):
        if name not in self.header:
            raise KeyError(f'missing column "{name}" (have: {self.header})')
        return self.header.index(name)

    def get(self, row, name):
        i = self.col(name)
        return row[i] if i < len(row) else ''


def table(cols, rows):
    return {'cols': cols, 'rows': rows}


def ga_overview(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        rate = num(t.get(r, 'Average Engagement Rate'))
        out.append([d, num(t.get(r, 'Total Users')), num(t.get(r, 'Active Users')), num(t.get(r, 'Sessions')),
                    round(rate * 100, 2) if rate <= 1 else rate, num(t.get(r, 'Total Key Events'))])
    return table(['date', 'totalUsers', 'activeUsers', 'sessions', 'engagementRate', 'keyEvents'], out)


def ga_traffic(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Default Channel Grouping')), text(t.get(r, 'Source / Medium')), text(t.get(r, 'Campaign')),
                    text(t.get(r, 'utm_content')), num(t.get(r, 'Sessions')), num(t.get(r, 'Engaged Sessions')), num(t.get(r, 'Active Users'))])
    return table(['date', 'defaultChannelGrouping', 'sourceMedium', 'campaign', 'utmContent', 'sessions', 'engagedSessions', 'activeUsers'], out)


def ga_pages(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Page Path / Screen Name')), num(t.get(r, 'Views')), num(t.get(r, 'Views per User')),
                    num(t.get(r, 'Average Engagement Time'))])
    return table(['date', 'pagePath', 'views', 'viewsPerUser', 'avgEngagementTimeSec'], out)


def ga_conversions(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Page Path')), text(t.get(r, 'Event Name')), num(t.get(r, 'Event Count')), num(t.get(r, 'Sessions on Page'))])
    return table(['date', 'pagePath', 'eventName', 'eventCount', 'sessionsOnPage'], out)


OBJECTIVES = {'LINK_CLICKS': 'Traffic', 'OUTCOME_LEADS': 'Leads', 'OUTCOME_TRAFFIC': 'Traffic', 'OUTCOME_AWARENESS': 'Awareness',
              'OUTCOME_ENGAGEMENT': 'Engagement', 'OUTCOME_SALES': 'Sales', 'REACH': 'Awareness', 'POST_ENGAGEMENT': 'Engagement'}


def paid(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        obj = text(t.get(r, 'Objective'))
        out.append([d, text(t.get(r, 'Platform')), text(t.get(r, 'Campaign Name')),
                    OBJECTIVES.get(obj, obj.replace('OUTCOME_', '').replace('_', ' ').title() or 'Other'),
                    num(t.get(r, 'Spend (USD)')), num(t.get(r, 'Impressions')), num(t.get(r, 'Reach')), num(t.get(r, 'Link Clicks')), num(t.get(r, 'Leads'))])
    return table(['date', 'platform', 'campaign', 'campaignObjective', 'spend', 'impressions', 'reach', 'linkClicks', 'leads'], out)


def email(t):
    """Dates come from 'Delivery Date' (filled on every row since 2026-10-02). For one-off emails (BATCH, BATCH (localtime), AB) it is
    the real send date. For AUTOMATED emails it is the HubSpot activation (last publish) date, NOT a send date, because automated
    emails send continuously. dateKind records which, so the dashboard can say so. A blank Delivery Date, or a sheet without the
    column, falls back to 'Created Date' and is marked 'created'."""
    has_delivery = 'Delivery Date' in t.header
    out = []
    for r in t.rows:
        kind = 'AUTOMATED' if text(t.get(r, 'Email Type')).upper() == 'AUTOMATED' else 'REGULAR'
        d = iso(t.get(r, 'Delivery Date')) if has_delivery else ''
        date_kind = ('activated' if kind == 'AUTOMATED' else 'sent') if d else 'created'
        if not d:
            d = iso(t.get(r, 'Created Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Email Name')), text(t.get(r, 'Campaign (CRM)')), kind, text(t.get(r, 'Subscription')),
                    num(t.get(r, 'Delivered')), num(t.get(r, 'Opens (excl. bots)')), num(t.get(r, 'Clicks (excl. bots)')),
                    num(t.get(r, 'Hard Bounces')), num(t.get(r, 'Soft Bounces')), num(t.get(r, 'Unsubscribes')), num(t.get(r, 'Spam Reports')), date_kind])
    return table(['date', 'emailName', 'campaignCRM', 'emailType', 'subscription', 'delivered', 'opens', 'clicks',
                  'hardBounces', 'softBounces', 'unsubscribes', 'spamReports', 'dateKind'], out)


def outreach(t):
    rows = []
    for r in t.rows:
        d = iso(t.get(r, 'Date of Outreach Activity'))
        if not d:
            continue
        rows.append([d, text(t.get(r, 'Location of Outreach Activity')) or 'Unspecified', text(t.get(r, 'Type of Experience')) or 'Other',
                     num(t.get(r, 'Flyers Distributed')), num(t.get(r, 'Meaningful Conversations'))])
    counts = Counter(r[1] for r in rows)
    for r in rows:
        if counts[r[1]] < MIN_LOCATION_ACTIVITIES:
            r[1] = 'Other locations'
    return table(['date', 'locationOfOutreachActivity', 'typeOfExperience', 'flyersDistributed', 'meaningfulConversations'], rows)


def mcp(t):
    out = []
    for r in t.rows:
        status = text(t.get(r, 'Status'))
        if status == 'Provisionally Completed':
            status = 'Completed'          # counted as completed; the dashboard says so
        cohort = text(t.get(r, 'Class: Program Cohort'))
        if 'Class: Fiscal Year' in t.header:          # the Salesforce tab carries the fiscal year directly
            fy = text(t.get(r, 'Class: Fiscal Year'))
        else:                                         # the export does not, so read it off the cohort ("FY24-25 Q2")
            m = re.search(r'FY\d{2}-\d{2}', cohort)
            fy = m.group(0) if m else ''
        out.append([iso(t.get(r, 'Class: Created Date')), status, text(t.get(r, 'Class: Course')), cohort,
                    text(t.get(r, 'Class: Class Name')), text(t.get(r, 'Class: Instructor')), fy])
    return table(['enrollmentDate', 'status', 'classCourse', 'classProgramCohort', 'className', 'classInstructor', 'fiscalYear'], out)


BUILDERS = {
    'GA4_Executive_Overview': ga_overview, 'GA4_Traffic_Acquisition': ga_traffic, 'GA4_Page_Engagement': ga_pages,
    'GA4_Isolated_Conversions': ga_conversions, 'Paid Media': paid, 'Email_Marketing_Data': email,
    'In_Person_Outreach_Log': outreach, 'MCP_Enrollment_Data': mcp,
}
def latest(tab):
    """Newest date that is not in the future (a typo like 2026-12-05 must not make a tab look fresh)."""
    i = tab['cols'].index('date') if 'date' in tab['cols'] else tab['cols'].index('enrollmentDate')
    today = dt.date.today().isoformat()
    dates = [r[i] for r in tab['rows'] if r[i] and r[i] <= today]
    return max(dates) if dates else None


def drop_partial_ga_week(tabs):
    """The newest GA week is often pulled mid-week (for example 63 sessions against ~775 normal), which makes every
    trend read as a collapse. If the last week is under 35% of the median of the four before it, leave it out."""
    ov = tabs['GA4_Executive_Overview']
    si = ov['cols'].index('sessions')
    by_week = {}
    for r in ov['rows']:
        by_week[r[0]] = by_week.get(r[0], 0) + r[si]
    weeks = sorted(by_week)
    if len(weeks) < 6:
        return None
    last, prior = weeks[-1], sorted(by_week[w] for w in weeks[-5:-1])
    median = (prior[1] + prior[2]) / 2
    if median <= 0 or by_week[last] >= 0.35 * median:
        return None
    for name, tab in tabs.items():
        if name.startswith('GA4_'):
            tab['rows'] = [r for r in tab['rows'] if r[0] != last]
    return last


EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+')


def scrub_emails(tabs):
    """data.json is public, so no email address may reach it. Some GA4 "pages" are broken email links (a path like
    /&user=name@...&sig=...) that carry a person's address. Any text cell with an address is cleaned: a page path
    becomes '(unrecognised link)', any other field has the address replaced by '(email hidden)'. Returns how many cells changed."""
    changed = 0
    for tab in tabs.values():
        cols = tab['cols']
        path_cols = {i for i, c in enumerate(cols) if c in ('pagePath', 'landingPage')}
        for row in tab['rows']:
            for i, v in enumerate(row):
                if isinstance(v, str) and '@' in v and EMAIL_RE.search(v):
                    row[i] = '(unrecognised link)' if i in path_cols else EMAIL_RE.sub('(email hidden)', v)
                    changed += 1
    return changed


def build(raw_dir, mcp_tab='MCP_Enrollment_Data'):
    tabs = {}
    for name, fn in BUILDERS.items():
        source = mcp_tab if name == 'MCP_Enrollment_Data' else name
        with open(os.path.join(raw_dir, source + '.json')) as f:
            rows = json.load(f)
        if not rows or len(rows) < 2:
            raise ValueError(f'{name}: no data rows')
        tabs[name] = fn(Tab(rows))
    scrubbed = scrub_emails(tabs)
    if scrubbed:
        print(f'removed an email address from {scrubbed} cell(s) before writing (data.json is public)')
    raw_ga_latest = latest(tabs['GA4_Executive_Overview'])   # before any partial week is dropped, so the stale-data check compares like with like
    partial = drop_partial_ga_week(tabs)
    today = dt.date.today()
    # The dashboard counts its range buttons back from the newest data in any tab (weekly tabs to the end of their newest week).
    ends = []
    for name, tab in tabs.items():
        newest = latest(tab)
        if newest:
            weekly = name.startswith('GA4_') or name == 'Paid Media'
            ends.append(dt.date.fromisoformat(newest) + dt.timedelta(days=6 if weekly else 0))
    anchor = min(today, max(ends)) if ends else today
    return {
        'generatedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'Marketing_Unified_Database_Backend (Google Sheet), synced by tools/marketing-data-sync',
        'mcpTab': mcp_tab,
        'granularity': 'week',
        'partialWeekDropped': partial,
        'rawGaLatest': raw_ga_latest,
        'anchorDate': anchor.isoformat(),
        'latest': {k: latest(v) for k, v in tabs.items()},
        'counts': {k: len(v['rows']) for k, v in tabs.items()},
        'tabs': tabs,
    }


def check(new, previous):
    problems = []
    for name in BUILDERS:
        if new['counts'].get(name, 0) == 0:
            problems.append(f'{name} is empty')
    if previous:
        for name in BUILDERS:
            old_n, new_n = previous.get('counts', {}).get(name, 0), new['counts'].get(name, 0)
            if old_n and new_n < old_n * 0.7:
                problems.append(f'{name} shrank from {old_n} to {new_n} rows')
        old_l = previous.get('rawGaLatest') or previous.get('latest', {}).get('GA4_Executive_Overview')
        new_l = new.get('rawGaLatest')
        if old_l and new_l and new_l < old_l:
            problems.append(f'GA4 data went backwards ({old_l} to {new_l})')
    return problems


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    raw_dir, out_path = argv[1], argv[2]
    previous = None
    if '--previous' in argv:
        p = argv[argv.index('--previous') + 1]
        if os.path.exists(p):
            with open(p) as f:
                previous = json.load(f)
    mcp_tab = argv[argv.index('--mcp-tab') + 1] if '--mcp-tab' in argv else 'MCP_Enrollment_Data'
    new = build(raw_dir, mcp_tab)
    problems = check(new, previous)
    if problems:
        print('REFUSING to write data.json:\n - ' + '\n - '.join(problems))
        return 2
    with open(out_path, 'w') as f:
        json.dump(new, f, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {out_path} ({os.path.getsize(out_path) // 1024} KB)')
    print('counts:', new['counts'])
    print('latest:', new['latest'], 'anchor:', new['anchorDate'])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
