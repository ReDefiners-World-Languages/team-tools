#!/usr/bin/env python3
"""Turn raw tabs from Marketing_Unified_Database_Backend into dashboards/marketing-funnel-performance/data.json.

Usage: transform.py RAW_DIR OUT_JSON [--previous PREVIOUS_JSON] [--mcp-tab TAB_NAME]

--mcp-tab picks which sheet tab feeds the Enrollments view (default MCP_Enrollment_Data). Use MCP_Enrollment_Data_SF once the
Salesforce tab is complete; the shrink check below refuses it while it has fewer rows than the tab it replaces.

RAW_DIR holds one <tab name>.json per tab: the sheet's values as a list of rows, header row first.
This file is public, so the output only carries the fields the dashboard draws. Never add personal data:
feedback forms, parent contacts, teacher names, staff "Created By" names and free-text notes stay out on purpose.
Teacher names in particular: the Top 10 teachers view is ranked here (teacher_ranking) and published as anonymous
[completed, total] pairs; the build stops if any instructor name from the sheet is found in the output.
The check at the end refuses to overwrite good data with a short or stale pull (exit code 2).
"""
import json, os, re, sys, datetime as dt
from collections import Counter
from fractions import Fraction

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


# --- Conversions tab: what brought people to each conversion (four tabs written by Paul, Analytics Expert) ---
# Tab names and headers belong to Paul: renaming one on the sheet breaks the dashboard, so it goes through Lucas first.
# data.json is public, so landing pages keep the path only: query strings carry tracking IDs (_hsenc, hsa_acc, fbclid ...).
# The Host column is not carried, and neither is Sessions from the pairs tab (it only counts sessions where the event fired,
# so it is not a rate denominator; the rate uses GA4_Landing_Page_Sessions). The first column of each stays 'date' so the
# partial-week rule below (tabs named GA4_*) covers them too.
def path_only(v):
    s = text(v).split('?')[0].split('#')[0] or '/'
    # A few GA4 "pages" are broken email links (for example /&user=name@...&sig=...) and can hold a staff email address.
    # Never publish those: a real path on the site has no @, = or & in it.
    return '(unrecognised link)' if re.search(r'[@=&]', s) else s


def conv_attribution(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Event Name')), text(t.get(r, 'Session Default Channel Group')), text(t.get(r, 'Channel (adjusted)')),
                    text(t.get(r, 'Session Source / Medium')), text(t.get(r, 'Session Campaign')),
                    path_only(t.get(r, 'Landing Page (path + query)')), num(t.get(r, 'Key Events')), num(t.get(r, 'Sessions'))])
    return table(['date', 'eventName', 'rawChannel', 'channel', 'sourceMedium', 'campaign', 'landingPage', 'keyEvents', 'sessions'], out)


def conv_first_touch(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Event Name')), text(t.get(r, 'First User Default Channel Group')), text(t.get(r, 'Channel (adjusted)')),
                    text(t.get(r, 'First User Source / Medium')), text(t.get(r, 'First User Campaign')),
                    num(t.get(r, 'Key Events')), num(t.get(r, 'Users'))])
    return table(['date', 'eventName', 'rawChannel', 'channel', 'sourceMedium', 'campaign', 'keyEvents', 'users'], out)


def conv_pairs(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, path_only(t.get(r, 'Landing Page (path, query stripped)')), text(t.get(r, 'Event Name')), num(t.get(r, 'Key Events'))])
    return table(['date', 'landingPage', 'eventName', 'keyEvents'], out)


def conv_landing_sessions(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, path_only(t.get(r, 'Landing Page (path, query stripped)')), num(t.get(r, 'Sessions')), num(t.get(r, 'Users'))])
    return table(['date', 'landingPage', 'sessions', 'users'], out)


# Funnel by entry page (two tabs written by Paul): Sessions -> Sessions Reaching Portal -> Sessions With MCP Registration.
# Weekly rows are the top 50 pages per week plus any page with a portal visit or registration, so column sums are a bit below the
# true site total. The daily tab has the same shape (first column "Date") for the last 90 complete days. Neither is a site total.
def funnel(date_header):
    def build(t):
        out = []
        for r in t.rows:
            d = iso(t.get(r, date_header))
            if not d:
                continue
            out.append([d, path_only(t.get(r, 'Landing Page (path, query stripped)')), num(t.get(r, 'Sessions')),
                        num(t.get(r, 'Sessions Reaching Portal')), num(t.get(r, 'Sessions With MCP Registration'))])
        return table(['date', 'landingPage', 'sessions', 'reachedPortal', 'registered'], out)
    return build


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


def num_or_none(v):
    """A blank cell is 'not logged yet', which is not the same as 0: it stays None (null in data.json) so the dashboard can say so
    and leave the row out of ratios. A typed 0 stays 0."""
    s = str(v if v is not None else '').strip()
    return None if s in ('', '-') else num(s)


# Partner sites are typed in several ways ("CBFRC - Central Tampa", "Children's Board Family Resource Center Central Tampa"). Rare
# locations are folded into "Other locations" below (free text can hold a person's name or a home address), so the long spellings of
# the big partner sites are mapped to the short name first; otherwise the newest entries would all fall into "Other locations".
def tidy_location(s):
    place = lambda p: re.sub(r"\bTown N\.? Country\b", "Town N' Country", p.strip(), flags=re.I)
    m = re.match(r"Children'?s Board Family Resource Center(?:\s+(?:of|at))?\s+(.+)$", s, re.I) or re.match(r"CBFRC\s+([A-Za-z' ]+)$", s)
    if m:
        return 'CBFRC - ' + place(m.group(1))
    m = re.match(r"Boys and Girls Club(?:\s+(?:of|at))?\s+(.+)$", s, re.I)
    if m:
        return 'BGC - ' + re.sub(r'^W\.? ', 'West ', place(m.group(1)))
    m = re.match(r"(Temple Terrace|Town N' Country) - BGC$", s)
    if m:
        return 'BGC - ' + m.group(1)
    return s


def outreach(t):
    rows = []
    for r in t.rows:
        d = iso(t.get(r, 'Date of Outreach Activity'))
        if not d:
            continue
        program = re.sub(r'\s+FY\d{2}-\d{2}$', '', text(t.get(r, 'Program')))   # "... (MCP) FY22-23" is the same program
        rows.append([d, tidy_location(text(t.get(r, 'Location of Outreach Activity'))) or 'Unspecified', text(t.get(r, 'Type of Experience')) or 'Other',
                     program or 'Not recorded', num_or_none(t.get(r, 'Flyers Distributed')), num_or_none(t.get(r, 'Meaningful Conversations'))])
    counts = Counter(r[1] for r in rows)
    for r in rows:
        if counts[r[1]] < MIN_LOCATION_ACTIVITIES:
            r[1] = 'Other locations'
    return table(['date', 'locationOfOutreachActivity', 'typeOfExperience', 'program', 'flyersDistributed', 'meaningfulConversations'], rows)


# Outreach traffic (written by Paul): visits tagged to printed and physical outreach materials, weekly, one row per
# group / source / campaign / utm_content / landing page. Paul classifies the Outreach Group; the dashboard never re-derives it.
# Session Medium is not carried: it is "(not set)" for printed materials, which is normal, and nothing draws it.
def outreach_traffic(t):
    out = []
    for r in t.rows:
        d = iso(t.get(r, 'Week Start Date'))
        if not d:
            continue
        out.append([d, text(t.get(r, 'Outreach Group')), text(t.get(r, 'Session Source')), text(t.get(r, 'Session Campaign')),
                    text(t.get(r, 'utm_content')), path_only(t.get(r, 'Landing Page')), num(t.get(r, 'Sessions')),
                    num(t.get(r, 'Engaged Sessions')), num(t.get(r, 'Users')), num(t.get(r, 'Sessions With MCP Registration'))])
    return table(['date', 'group', 'source', 'campaign', 'utmContent', 'landingPage', 'sessions', 'engagedSessions', 'users', 'registered'], out)


def mcp_status(t, r):
    status = text(t.get(r, 'Status'))
    return 'Completed' if status == 'Provisionally Completed' else status   # counted as completed; the dashboard says so


def mcp_fiscal_year(t, r):
    cohort = text(t.get(r, 'Class: Program Cohort'))
    if 'Class: Fiscal Year' in t.header:          # the Salesforce tab carries the fiscal year directly
        return text(t.get(r, 'Class: Fiscal Year'))
    m = re.search(r'FY\d{2}-\d{2}', cohort)       # the export does not, so read it off the cohort ("FY24-25 Q2")
    return m.group(0) if m else ''


# Class names carry a code "N.Q" (for example "ESOL Basic Living (3.2)"): N is the program year (3 = FY24-25, 4 = FY25-26,
# 5 = FY26-27), Q is the quarter, 1 to 4. FY22-23 and FY23-24 use letters instead ("(1B)", "(2C)") and are NOT parsed here.
# The pattern must not read part of a longer number: "10.25", "1.2.3" and "$5.2" are not codes.
QUARTER_CODE = re.compile(r'(?<![\d.$])\d{1,2}\.([1-4])(?!\d|\.\d)')
QUARTER_CODE_IN_PARENS = re.compile(r'\(\s*\d{1,2}\.([1-4])\s*\)')


def class_quarter(class_name):
    """'Q1'..'Q4' from the code in a class name, '' when there is no code or it is ambiguous (two different quarters)."""
    found = {m.group(1) for m in QUARTER_CODE_IN_PARENS.finditer(class_name)} or {m.group(1) for m in QUARTER_CODE.finditer(class_name)}
    return 'Q' + found.pop() if len(found) == 1 else ''


def mcp(t):
    # The sheet's "Class: Instructor" column is NOT carried: data.json is public and teacher names must never reach it.
    out = []
    for r in t.rows:
        out.append([iso(t.get(r, 'Class: Created Date')), mcp_status(t, r), text(t.get(r, 'Class: Course')),
                    text(t.get(r, 'Class: Program Cohort')), text(t.get(r, 'Class: Class Name')), mcp_fiscal_year(t, r),
                    class_quarter(text(t.get(r, 'Class: Class Name')))])
    return table(['enrollmentDate', 'status', 'classCourse', 'classProgramCohort', 'className', 'fiscalYear', 'quarter'], out)


TEACHER_MIN_ENROLLMENTS = 3   # a teacher needs at least this many enrollments in the filter to be ranked
TEACHER_TOP_N = 10


def teacher_ranking(t):
    """Top teachers by completion rate, with NO names and NO teacher ids, for every Fiscal year x Quarter filter the
    Enrollments tab offers: ranking[fy][quarter] with fy = "all" or "FY25-26" and quarter = "all", "Q1".."Q4" or "none"
    (no code in the class name). The instructor column is read here and only ever leaves this function as [completed, total]
    pairs, best first; the dashboard labels them "Teacher 1", "Teacher 2" ... from their position. No per-row teacher key
    is published, so the ranking cannot be joined back to a class name or a cohort. Same rule the dashboard used before:
    rate = completed / total, ties broken by more enrollments, teachers under TEACHER_MIN_ENROLLMENTS left out."""
    # 'Class: Instructor' absent (older export): publish nothing rather than fail the whole sync.
    if 'Class: Instructor' not in t.header:
        return {}
    groups = {}
    for r in t.rows:
        name = text(t.get(r, 'Class: Instructor'))
        if not name:
            continue
        cohort = text(t.get(r, 'Class: Program Cohort'))
        m = re.search(r'FY\d{2}-\d{2}', cohort, re.I)
        fy = (mcp_fiscal_year(t, r) or (m.group(0) if m else cohort)).upper()   # the key the dashboard's filter uses (fyOf)
        quarter = class_quarter(text(t.get(r, 'Class: Class Name'))) or 'none'
        done = mcp_status(t, r) == 'Completed'
        for fy_key in ('all', fy):
            for q_key in ('all', quarter):
                g = groups.setdefault((fy_key, q_key), {}).setdefault(name, [0, 0])
                g[1] += 1
                g[0] += 1 if done else 0
    ranking = {}
    for (fy_key, q_key), by_name in sorted(groups.items()):
        pairs = [tuple(v) for v in by_name.values() if v[1] >= TEACHER_MIN_ENROLLMENTS]
        pairs.sort(key=lambda v: (-Fraction(v[0], v[1]), -v[1]))
        ranking.setdefault(fy_key, {})[q_key] = [list(v) for v in pairs[:TEACHER_TOP_N]]
    return ranking


def instructor_names(t):
    if 'Class: Instructor' not in t.header:
        return set()
    return {text(t.get(r, 'Class: Instructor')) for r in t.rows if len(text(t.get(r, 'Class: Instructor'))) >= 4}


BUILDERS = {
    'GA4_Executive_Overview': ga_overview, 'GA4_Traffic_Acquisition': ga_traffic, 'GA4_Page_Engagement': ga_pages,
    'GA4_Conversion_Attribution': conv_attribution, 'GA4_Conversion_First_Touch': conv_first_touch,
    'GA4_Conversion_Landing_Pairs': conv_pairs, 'GA4_Landing_Page_Sessions': conv_landing_sessions,
    'GA4_Funnel_Entry_To_Conversion': funnel('Week Start Date'), 'GA4_Funnel_Entry_To_Conversion_Daily': funnel('Date'),
    'GA4_Outreach_Traffic': outreach_traffic,
    'Paid Media': paid, 'Email_Marketing_Data': email,
    'In_Person_Outreach_Log': outreach, 'MCP_Enrollment_Data': mcp,
}
# GA4_Isolated_Conversions (event + page it fired on) is no longer synced: the redesigned Conversions tab replaced it. The sheet tab stays (Paul).


# Tabs that may be missing from a pull (added after the first version of the sync): they are skipped, not an error, and the
# dashboard says the funnel is not synced yet. DAILY_TABS hold one row per day, not per week, whatever their name starts with.
OPTIONAL_TABS = {'GA4_Funnel_Entry_To_Conversion', 'GA4_Funnel_Entry_To_Conversion_Daily', 'GA4_Outreach_Traffic'}
DAILY_TABS = {'GA4_Funnel_Entry_To_Conversion_Daily'}


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
        if name.startswith('GA4_') and name not in DAILY_TABS:
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


def names_in(payload, names):
    """Last line of defence: how many of the sheet's instructor names appear anywhere in what is about to be written."""
    blob = json.dumps(payload, ensure_ascii=False)
    return sum(1 for n in names if n in blob)


def build(raw_dir, mcp_tab='MCP_Enrollment_Data'):
    tabs = {}
    for name, fn in BUILDERS.items():
        source = mcp_tab if name == 'MCP_Enrollment_Data' else name
        if name in OPTIONAL_TABS and not os.path.exists(os.path.join(raw_dir, source + '.json')):
            print(f'{name}: not in this pull, skipped')
            continue
        with open(os.path.join(raw_dir, source + '.json')) as f:
            rows = json.load(f)
        if not rows or len(rows) < 2:
            raise ValueError(f'{name}: no data rows')
        tab = Tab(rows)
        tabs[name] = fn(tab)
        if name == 'MCP_Enrollment_Data':
            ranking = teacher_ranking(tab)
            names = instructor_names(tab)
            qi = tabs[name]['cols'].index('quarter')
            unmatched = Counter(r[tabs[name]['cols'].index('fiscalYear')] for r in tabs[name]['rows'] if not r[qi])
            print('enrollment rows with no quarter code in the class name, by fiscal year:', dict(sorted(unmatched.items())) or 'none')
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
            weekly = (name.startswith('GA4_') and name not in DAILY_TABS) or name == 'Paid Media'
            ends.append(dt.date.fromisoformat(newest) + dt.timedelta(days=6 if weekly else 0))
    anchor = min(today, max(ends)) if ends else today
    payload = {
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
        'mcpTeacherRanking': ranking,
    }
    leaked = names_in(payload, names)
    if leaked:
        raise ValueError(f'{leaked} teacher name(s) are present in the output; refusing to write them to the public data.json')
    return payload


def check(new, previous):
    problems = []
    for name in BUILDERS:
        if name in OPTIONAL_TABS and name not in new['counts']:
            continue
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
