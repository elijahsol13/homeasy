#!/usr/bin/env python3
"""Guarded, evidence-bound repair of verified public HomeEasy listing defects.

Dry-run by default. Apply ONLY after a SQLite-consistent backup and rehearsal:
  python3 scripts/repair-visible-listing-defects-20261023.py --db /tmp/clone.db
  python3 scripts/repair-visible-listing-defects-20261023.py --db /tmp/clone.db --apply --expected-public 240

Does not run LLMs, scrape, or alter source_items. A source/current-value mismatch
aborts the whole transaction, rather than silently repairing the wrong row.
"""
import argparse
import json
import sqlite3
from pathlib import Path


# canonical_id: (old sangkat, intended sangkat, evidence in the original body or source title)
LOCATIONS = {
    16516: ('Sala Kram', 'Sla Kram', 'Sla Kram'),
    16500: (None, 'Srangae', 'Sra Ngae area'),
    9852: (None, 'Svay Dangkum', 'Svay Dankum area'),
    407: ('Sala Kamreuk', 'Sla Kram', 'ស្លក្រាម'),
    9135: (None, 'Svay Dangkum', 'Svay Dankum area'),
    107: ('Slok Kram', 'Sla Kram', 'Slarkram'),
    278: ('Salakamreauk', 'Sala Kamreuk', 'Sangkat Salakamreauk'),
    8710: ('Kork Chak', 'Kouk Chak', 'Kork Chak Commune'),
    9744: ('Chreav, Siem Reap, Siem Reap', 'Chreav', 'Chreav'),
    9778: ('Sala Kamraeuk, Siem Reap, Siem Reap', 'Sala Kamreuk', 'Sala Kamraeuk'),
    2902: ('Sala Kamraeuk, Siem Reap, Siem Reap', 'Sala Kamreuk', 'Sala Kamraeuk'),
    16520: ('Sala Kamraeuk, Siem Reap, Siem Reap', 'Sala Kamreuk', 'Sala Kamraeuk'),
    2726: ('Sla Kram, Siem Reap, Siem Reap', 'Sla Kram', 'Sangkat Sla Kram'),
    2067: ('Svay Dangkum, Siem Reap, Siem Reap', 'Svay Dangkum', 'Sangkat Svay Dangkum'),
    2619: ('Svay Dangkum, Siem Reap, Siem Reap', 'Svay Dangkum', 'Svay Dankum Commune'),
    2956: ('Svay Dangkum, Siem Reap, Siem Reap', 'Svay Dangkum', 'Sangkat Svay Dangkum'),
    2968: ('Svay Dangkum, Siem Reap, Siem Reap', 'Svay Dangkum', 'Svay Dangkum area'),
    # Platform location is used only when the author's text is silent. Source
    # title is another independent item of evidence when included below.
    8389: (None, 'Sla Kram', 'Sla Kram, Siem Reap, Siem Reap'),
    10879: (None, 'Sala Kamreuk', 'Sala Kamraeuk, Siem Reap, Siem Reap'),
    16507: (None, 'Sala Kamreuk', 'Sala Kamraeuk, Siem Reap, Siem Reap'),
    16506: (None, 'Sla Kram', 'Sla Kram, Siem Reap, Siem Reap'),
    16503: (None, 'Svay Dangkum', 'Svay Dankum, Siem Reap'),
    9557: (None, 'Svay Dangkum', 'Svay Dangkum, Siem Reap'),
}


def changes_for(id_, row, facts):
    """Compute only the verified changes for the four authorized problem groups."""
    changes = {}
    if id_ in LOCATIONS:
        old, new, _ = LOCATIONS[id_]
        assert row['sangkat'] == old, f'{id_}: sangkat drift: {row["sangkat"]!r} != {old!r}'
        changes['sangkat'] = new
        facts['sangkat'] = new

    if id_ == 16516:
        assert (row['title'], row['category'], row['property_type'], row['explicit_location']) == (
            '3-Bedroom House in Sala Kram', 'house', 'Private House', 'Sala Kram')
        assert 'Sala Kram' in row['description']
        changes.update(title='3-Bedroom Apartment in Sla Kram',
                       description=row['description'].replace('3-bedroom house', '3-bedroom apartment')
                           .replace('Sala Kram', 'Sla Kram'),
                       category='apartment', property_type='Apartment', explicit_location='Sla Kram')
    elif id_ == 16513:
        assert (row['bedrooms'], row['bathrooms'], row['title']) == (
            None, 4, 'Semi-Furnished Private House in Chreav')
        assert 'Layout: 3 Bed | 4 Bath' in row['raw_text']
        changes.update(bedrooms=3, title='3-Bedroom House in Chreav',
                       description=row['description'].replace('4-bathroom private house',
                           '3-bedroom, 4-bathroom private house'))
    elif id_ == 16511:
        assert 'Zannier Phum Baitang Hotel' in row['raw_text']
        assert 'Zannier Phum Baitang Hotel' in facts.get('landmarks', [])
        assert facts.get('marketing_landmarks') == ['close to Zannier Phum Baitang Hotel']
        facts['marketing_landmarks'] = []
    elif id_ == 16500:
        assert row['title'] == '2-Bedroom Villa in Sra Ngae'
        changes.update(title='2-Bedroom Villa in Srangae',
                       description=row['description'].replace('Sra Ngae area', 'Srangae (Sra Ngae) area'))
    elif id_ == 407:
        assert row['title'] == '1-Bedroom House in Sala Kamreuk'
        assert 'Sala Kamreuk' in row['description']
        changes.update(title='1-Bedroom House in Sla Kram',
                       description=row['description'].replace('Sala Kamreuk', 'Sla Kram'),
                       explicit_location='Sla Kram')
    elif id_ in (9852, 9135):
        assert 'Svay Dankum' in row['title'] and 'Svay Dankum' in row['description']
        changes.update(title=row['title'].replace('Svay Dankum', 'Svay Dangkum'),
                       description=row['description'].replace('Svay Dankum', 'Svay Dangkum'))
    elif id_ in (107, 278, 8710, 16520):
        replacements = {107: ('Slarkram', 'Sla Kram'),
                        278: ('Salakamreauk', 'Sala Kamreuk'),
                        8710: ('Kork Chak', 'Kouk Chak'),
                        16520: ('Sala Kamraeuk', 'Sala Kamreuk')}
        old, new = replacements[id_]
        changes.update(title=row['title'].replace(old, new),
                       description=row['description'].replace(old, new))
        if row['explicit_location'] and old in row['explicit_location']:
            # Retain the evidence's original spelling in explicit_location;
            # only the separate administrative sangkat gets canonicalized.
            pass

    for column in ('title', 'description', 'bedrooms', 'category', 'property_type', 'explicit_location'):
        if column in changes:
            fact_key = {'title':'title_en', 'description':'description_en'}.get(column, column)
            facts[fact_key] = changes[column]
    changes['listing_facts_json'] = json.dumps(facts, ensure_ascii=False, separators=(',', ':'))
    return changes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='data/homeasy.db')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--expected-public', type=int)
    args = ap.parse_args()
    if args.apply and (args.expected_public is None or args.expected_public <= 0):
        ap.error('--apply requires --expected-public from the verified rehearsal')
    db = sqlite3.connect(f'file:{Path(args.db).resolve()}?mode={"rw" if args.apply else "ro"}', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=10000')
    if not args.apply: db.execute('PRAGMA query_only=ON')
    ids = sorted(set(LOCATIONS) | {16513, 16511})
    try:
        if args.apply: db.execute('BEGIN IMMEDIATE')
        cohort = db.execute("""SELECT COUNT(*) FROM canonical_listings l WHERE
            l.status='active' AND l.city='siem_reap' AND l.availability_status NOT IN ('rented','removed')""").fetchone()[0]
        if args.expected_public is not None and cohort != args.expected_public:
            raise ValueError(f'Public cohort drift: expected {args.expected_public}, found {cohort}')
        rows=[]
        for id_ in ids:
            row = db.execute("""SELECT l.id,l.title,l.description,l.category,l.property_type,l.bedrooms,
                l.bathrooms,l.sangkat,l.explicit_location,l.listing_facts_json,s.raw_text,s.raw_payload_json
                FROM canonical_listings l JOIN canonical_listing_source_occurrences o
                ON o.id=l.primary_source_occurrence_id AND o.is_current=1
                JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?""", (id_,)).fetchone()
            if not row: raise ValueError(f'{id_}: primary source missing or no longer current')
            raw = row['raw_text'] or ''
            payload = json.loads(row['raw_payload_json'] or '{}').get('listing') or {}
            platform_evidence = '\n'.join(str(payload.get(field) or '') for field in ('source_title', 'location'))
            if id_ in LOCATIONS:
                _, _, must_contain = LOCATIONS[id_]
                if must_contain.casefold() not in (raw + '\n' + platform_evidence).casefold():
                    raise ValueError(f'{id_}: expected source/location evidence missing: {must_contain}')
            facts=json.loads(row['listing_facts_json'] or '{}')
            if not isinstance(facts, dict): raise ValueError(f'{id_}: invalid stored facts')
            changes=changes_for(id_, row, facts)
            if args.apply:
                columns=', '.join(f'{key}=?' for key in changes)
                result=db.execute(f"UPDATE canonical_listings SET {columns}, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
                                  (*changes.values(), id_))
                if result.rowcount != 1: raise ValueError(f'{id_}: update count {result.rowcount}')
            rows.append({'id':id_, 'before':row['sangkat'], 'after':changes.get('sangkat', row['sangkat']),
                         'updatedColumns':[key for key in changes if key!='listing_facts_json']})
        if args.apply:
            if db.execute('PRAGMA foreign_key_check').fetchall(): raise ValueError('Foreign-key check failed')
            db.commit()
        print(json.dumps({'mode':'applied' if args.apply else 'dry-run','db':str(Path(args.db).resolve()),
                          'activeCityCohort':cohort,'count':len(rows),'rows':rows}, ensure_ascii=False, indent=2))
    except Exception:
        if args.apply: db.rollback()
        raise
    finally: db.close()


if __name__ == '__main__': main()
