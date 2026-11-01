# Builds a preview copy of data/ with made-up monthly splits and MLB monthly
# totals, for screenshots. Never commit its output.
# Usage: python3 scripts/preview/fake-data.py data <out-dir>
import json, random, sys, os, math
src, dst = sys.argv[1], sys.argv[2]
random.seed(7)
idx = json.load(open(f"{src}/index.json"))
json.dump(idx, open(f"{dst}/index.json","w"))
def split(total, w):
    # distribute integer total across weights
    s=sum(w); raw=[total*x/s for x in w]; out=[math.floor(r) for r in raw]
    rem=total-sum(out)
    for i in sorted(range(len(w)), key=lambda i: raw[i]-out[i], reverse=True)[:rem]: out[i]+=1
    return out
MONTHS=[3,4,5,6,7,8,9]
for season in idx["seasons"]:
    d=json.load(open(f"{src}/{season}.json"))
    for p in d["hitters"]:
        n=random.choice([7,7,7,5,4,3,2]); start=random.randint(0,7-n); ms=MONTHS[start:start+n]
        w=[ (0.3 if m==3 else 1)*random.uniform(.7,1.3) for m in ms]
        pa=split(p["pa"],w); g=split(p["g"],w)
        # hit quality varies by month
        q=[random.uniform(.6,1.4) for _ in ms]
        lines=[]
        ab=split(p["ab"],w); bb=split(p["bb"],w); so=split(p["so"],w)
        h=split(p["h"],[w[i]*q[i] for i in range(len(ms))]); hr=split(p["hr"],[w[i]*q[i]**2 for i in range(len(ms))])
        rbi=split(p["rbi"],[w[i]*q[i] for i in range(len(ms))]); r=split(p["r"],w); sb=split(p["sb"],w)
        for i,m in enumerate(ms):
            hh=min(h[i],ab[i]); hrr=min(hr[i],hh); dd=min(round((hh-hrr)*.22),hh-hrr)
            lines.append(dict(m=m,g=g[i],pa=pa[i],ab=ab[i],h=hh,d=dd,t=0,hr=hrr,r=r[i],rbi=rbi[i],bb=bb[i],hbp=round(pa[i]*.01),sf=round(pa[i]*.008),so=so[i],sb=sb[i]))
        p["months"]=lines
    for p in d["pitchers"]:
        n=random.choice([7,7,6,4,3,2,1]); start=random.randint(0,7-n); ms=MONTHS[start:start+n]
        w=[(0.3 if m==3 else 1)*random.uniform(.6,1.4) for m in ms]
        q=[random.uniform(.5,1.6) for _ in ms]
        o=split(p["outs"],w); g=split(p["g"],w); gs=split(p["gs"],w)
        er_total=round((p["era"] or 4)*p["outs"]/27)
        er=split(er_total,[w[i]*q[i] for i in range(len(ms))])
        so=split(p["so"],w); bb=split(p["bb"],w)
        h_total=max(0,round((p["whip"] or 1.3)*p["outs"]/3)-p["bb"])
        hh=split(h_total,[w[i]*q[i] for i in range(len(ms))])
        wins=split(p["w"],w); ls=split(p["l"],w); sv=split(p["sv"],w); hld=split(p["hld"],w)
        p["months"]=[dict(m=m,g=g[i],gs=gs[i],w=wins[i],l=ls[i],sv=sv[i],hld=hld[i],er=er[i],h=hh[i],bb=bb[i],so=so[i],hr=round(hh[i]*.12),bf=o[i]+hh[i]+bb[i],outs=o[i]) for i,m in enumerate(ms)]
    # league: 30 teams, ~26 games per month
    hit=[];pit=[]
    for m in MONTHS:
        gpm = 30*(5 if m==3 else 27)
        pa=gpm*38; ab=round(pa*.89)
        avg=random.uniform(.236,.252); hh=round(ab*avg)
        hr=round(pa*random.uniform(.028,.033)); dd=round(hh*.2); tt=round(hh*.015)
        bb=round(pa*.084); so=round(pa*random.uniform(.215,.232)); r=round(gpm*random.uniform(4.2,4.7))
        hit.append(dict(m=m,g=gpm,pa=pa,ab=ab,h=hh,d=dd,t=tt,hr=hr,r=r,rbi=round(r*.95),bb=bb,hbp=round(pa*.011),sf=round(pa*.008),so=so,sb=round(gpm*.7)))
        outs=gpm*26.6
        pit.append(dict(m=m,g=gpm,gs=gpm,w=gpm//2,l=gpm//2,sv=round(gpm*.12),hld=round(gpm*.4),er=round(r*.92),h=hh,bb=bb,so=so,hr=hr,bf=pa,outs=round(outs)))
    d["league"]={"hitting":hit,"pitching":pit}
    json.dump(d, open(f"{dst}/{season}.json","w"))
print("ok")
