#!/usr/bin/env python3
"""Turn raw tabs of the ReDefiners_social_media_metrics Google Sheet into dashboards/social-media-analytics/data.json.

Usage:
  python3 transform.py RAW_DIR OUT_JSON [--previous PREVIOUS_JSON] [--today YYYY-MM-DD]

RAW_DIR holds one <tab name>.json per tab, each the `values` list (list of rows) from GOOGLESHEETS_VALUES_GET read with
value_render_option=UNFORMATTED_VALUE (so decimals are not turned into "3,17"). See README.md.

Exit codes: 0 ok, 2 the pull looks wrong (missing/empty tab, a series shrank, newest follower date went backwards).
Nothing is written when the exit code is 2.

Only the fields the dashboard draws are kept. Competitor tabs, LinkedIn visitor tabs and TikTok viewer/overview tabs are not used.
"""
import argparse, datetime, hashlib, json, os, re, sys

TABS = ['Posts_Unified', 'YouTube_Videos_Unified', 'YouTube_Channel_Snapshot', 'Facebook_Followers_Daily',
        'Instagram_Followers_Daily', 'TikTok_Followers_Daily', 'LinkedIn_Followers_Daily',
        'Instagram_Audience_Demographics', 'LinkedIn_Followers_Demographics', 'Best_Time_To_Post_Heatmap']
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
HEATMAP_PLATFORM = {'ig': 'Instagram', 'fb': 'Facebook', 'tk': 'TikTok', 'yt': 'YouTube', 'li': 'LinkedIn'}


class Bad(Exception):
    pass


def tonum(x):
    if isinstance(x, bool):
        return 0
    if isinstance(x, (int, float)):
        return int(x) if float(x).is_integer() else x
    s = str(x or '').strip()
    if not s:
        return 0
    if re.fullmatch(r'-?\d{1,3}(,\d{3})+', s):
        s = s.replace(',', '')
    try:
        f = float(s)
    except ValueError:
        return 0
    return int(f) if f.is_integer() else f


def day(x):
    # Date cells can arrive as Google serial numbers (days since 1899-12-30) when read UNFORMATTED without a string date option.
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(x))).isoformat()
    return str(x or '')[:10]


def title(x):
    t = re.sub(r'\s+', ' ', str(x or '')).strip()
    return t if len(t) <= 200 else t[:199].rstrip() + '…'


def load(raw_dir):
    tabs = {}
    for t in TABS:
        p = os.path.join(raw_dir, t + '.json')
        if not os.path.exists(p):
            raise Bad('missing tab file: %s' % t)
        v = json.load(open(p))
        if len(v) < 2:
            raise Bad('tab %s has no data rows' % t)
        head = v[0]
        tabs[t] = [dict(zip(head, r + [''] * (len(head) - len(r)))) for r in v[1:]]
    return tabs


def posts_for(rows, platform, build):
    out = [build(r) for r in rows if r['Platform'] == platform and day(r['Date'])]
    out.sort(key=lambda p: p['date'])
    return out


def build_posts(T):
    P = T['Posts_Unified']
    ig_type = {'image': 'Image', 'carousel': 'Carousel', 'reel': 'Reel', 'video': 'Video'}

    def ig(r):
        t = str(r['Post_Type']).lower().replace('ig ', '').strip()
        return {'date': day(r['Date']), 'type': ig_type.get(t, 'Post'), 'title': title(r['Title_Description']),
                'views': tonum(r['Views']), 'reach': tonum(r['Reach']), 'likes': tonum(r['Likes_Reactions']),
                'comments': tonum(r['Comments']), 'saved': tonum(r['Saves']), 'shares': tonum(r['Shares']), 'link': r['Permalink']}

    def fb(r):
        return {'date': day(r['Date']), 'title': title(r['Title_Description']), 'views': tonum(r['Views']),
                'reactions': tonum(r['Likes_Reactions']), 'comments': tonum(r['Comments']), 'shares': tonum(r['Shares']), 'link': r['Permalink']}

    def tk(r):
        return {'date': day(r['Date']), 'title': title(r['Title_Description']), 'views': tonum(r['Views']),
                'likes': tonum(r['Likes_Reactions']), 'comments': tonum(r['Comments']), 'shares': tonum(r['Shares']), 'link': r['Permalink']}

    def li(r):
        return {'date': day(r['Date']), 'title': title(r['Title_Description']), 'impressions': tonum(r['Impressions']),
                'likes': tonum(r['Likes_Reactions']), 'comments': tonum(r['Comments']), 'shares': tonum(r['Shares']), 'link': r['Permalink']}

    yt_rows = [{'Platform': 'YouTube', **r} for r in T['YouTube_Videos_Unified']]

    def yt(r):
        return {'date': day(r['Date']), 'title': title(r['Title']), 'views': tonum(r['Views']), 'likes': tonum(r['Likes']),
                'comments': tonum(r['Comments']), 'link': r['Permalink']}

    return {'ig': posts_for(P, 'Instagram', ig), 'fb': posts_for(P, 'Facebook', fb), 'tk': posts_for(P, 'TikTok', tk),
            'yt': posts_for(yt_rows, 'YouTube', yt), 'li': posts_for(P, 'LinkedIn', li), 'x': []}


def series(rows, date_col, val_col):
    d = {}
    for r in rows:
        if day(r[date_col]):
            d[day(r[date_col])] = tonum(r[val_col])
    return [{'date': k, 'count': d[k]} for k in sorted(d)]


def linkedin_followers(T):
    """Total_Followers_That_Day is a daily delta. Rebuild a running total anchored on the follower total the demographics
    tab reports (sum of its Location rows)."""
    anchor = sum(tonum(r['Followers']) for r in T['LinkedIn_Followers_Demographics'] if r['Dimension'] == 'Location')
    rows = sorted(((day(r['Date']), tonum(r['Total_Followers_That_Day'])) for r in T['LinkedIn_Followers_Daily'] if day(r['Date'])))
    out, after = [], 0
    for d, delta in reversed(rows):
        out.append({'date': d, 'count': anchor - after})
        after += delta
    out.reverse()
    return out, anchor


def top_locations(rows, limit=10):
    tot = sum(r[1] for r in rows)
    rows = sorted(rows, key=lambda r: -r[1])[:limit]
    return [{'name': n, 'percentage': round(v / tot * 100, 2)} for n, v in rows] if tot else []


def heatmap(T):
    rows = T['Best_Time_To_Post_Heatmap']
    out = {}
    for key, plat in HEATMAP_PLATFORM.items():
        mine = [r for r in rows if r['Platform'] == plat]
        mx = max([tonum(r['Avg_Engagement_per_Post']) for r in mine] or [0])
        out[key] = [{'day': str(r['Day_of_Week'])[:3], 'hour': int(tonum(r['Hour_of_Day_UTC'])),
                     'score': round(tonum(r['Avg_Engagement_per_Post']) / mx, 4) if mx else 0.0} for r in mine]
    return out


def build_audience(T):
    ig_f = series(T['Instagram_Followers_Daily'], 'Date', 'Estimated_Total_Followers')
    fb_f = series(T['Facebook_Followers_Daily'], 'Date', 'Total_Followers')
    tk_f = series(T['TikTok_Followers_Daily'], 'Date', 'Total_Followers')
    li_f, li_total = linkedin_followers(T)
    snap = T['YouTube_Channel_Snapshot'][-1]
    yt_f = [{'date': day(snap['Date_Pulled']), 'count': tonum(snap['Subscriber_Count'])}]
    demo = T['Instagram_Audience_Demographics']
    age = [{'range': r['Segment'], 'count': tonum(r['Followers'])} for r in demo if r['Dimension'] == 'Age']
    gender = {str(r['Segment']).lower(): tonum(r['Followers']) for r in demo if r['Dimension'] == 'Gender'}
    ig_loc = top_locations([(r['Segment'], tonum(r['Followers'])) for r in demo if r['Dimension'] == 'City'])
    li_loc = top_locations([(r['Segment'], tonum(r['Followers'])) for r in T['LinkedIn_Followers_Demographics'] if r['Dimension'] == 'Location'])
    ot = heatmap(T)

    def aud(f, key, demographics=None, locs=None):
        return {'dailyFollowers': f, 'demographics': demographics or {}, 'topLocations': locs or [],
                'hasDemographics': bool(demographics), 'onlineTimes': ot.get(key, [])}
    audience = {'ig': aud(ig_f, 'ig', {'age': age, 'gender': gender}, ig_loc), 'fb': aud(fb_f, 'fb'), 'tk': aud(tk_f, 'tk'),
                'yt': aud(yt_f, 'yt'), 'li': aud(li_f, 'li', None, li_loc), 'x': {'dailyFollowers': [], 'demographics': {},
                                                                                 'topLocations': [], 'hasDemographics': False}}
    last = lambda f: f[-1]['count'] if f else None
    accounts = {k: {'followers': last(audience[k]['dailyFollowers'])} for k in ['ig', 'fb', 'tk', 'yt', 'li', 'x']}
    return audience, accounts


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw_dir'); ap.add_argument('out')
    ap.add_argument('--previous'); ap.add_argument('--today')
    a = ap.parse_args()
    today = a.today or datetime.date.today().isoformat()
    try:
        T = load(a.raw_dir)
        posts = build_posts(T)
        audience, accounts = build_audience(T)
    except Bad as e:
        print('STOP:', e); sys.exit(2)

    # Section "last changed" dates: the sheet has no edit date per tab, so the sync records the day it first saw different content.
    hashes = {'heatmap': digest(heatmap(T)),
              'demographics': digest([audience['ig']['demographics'], audience['ig']['topLocations'], audience['li']['topLocations']])}
    prev = None
    if a.previous and os.path.exists(a.previous):
        prev = json.load(open(a.previous))
    updated = {}
    for k, h in hashes.items():
        pu = (prev or {}).get('sectionUpdated', {}).get(k)
        updated[k] = pu['date'] if pu and pu.get('hash') == h else today
    section = {k: {'date': updated[k], 'hash': hashes[k]} for k in hashes}

    latest = {k: (posts[k][-1]['date'] if posts[k] else None) for k in posts}
    latest_f = {k: (audience[k]['dailyFollowers'][-1]['date'] if audience[k]['dailyFollowers'] else None) for k in audience}
    through = max(d for d in [latest_f['ig'], latest_f['fb']] if d)

    problems = []
    if prev:
        for k, v in posts.items():
            old = prev['posts'].get(k, [])
            if old and len(v) < len(old) * 0.95:
                problems.append('%s posts shrank %d -> %d' % (k, len(old), len(v)))
        for k, v in audience.items():
            old = prev['audience'].get(k, {}).get('dailyFollowers', [])
            if old and len(v['dailyFollowers']) < len(old) * 0.7:
                problems.append('%s follower history shrank %d -> %d' % (k, len(old), len(v['dailyFollowers'])))
        for k in ('ig', 'fb'):
            po = (prev.get('latestFollowerDate') or {}).get(k)
            if po and latest_f[k] and latest_f[k] < po:
                problems.append('%s newest follower date went backwards %s -> %s' % (k, po, latest_f[k]))
    if problems:
        print('STOP: the pull looks wrong:\n  ' + '\n  '.join(problems)); sys.exit(2)

    out = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'dataThrough': through, 'accounts': accounts, 'posts': posts, 'audience': audience,
           'latestPostDate': latest, 'latestFollowerDate': latest_f, 'sectionUpdated': section}
    # Keep generatedAt stable when nothing else changed, so an unchanged sheet gives an identical file (no empty commits).
    if prev:
        a2 = dict(out); b2 = dict(prev); a2.pop('generatedAt'); b2.pop('generatedAt', None)
        if a2 == b2:
            out['generatedAt'] = prev['generatedAt']
    with open(a.out, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('posts:', {k: len(v) for k, v in posts.items()})
    print('followers newest:', latest_f)
    print('posts newest:', latest)
    print('accounts:', {k: v['followers'] for k, v in accounts.items()})
    print('heatmap last changed:', updated['heatmap'], '| demographics last changed:', updated['demographics'])
    print('data through:', through)


if __name__ == '__main__':
    main()
