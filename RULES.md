# RULES

**The single source of truth. Read this before writing anything that leaves the building, before
changing the cadence, and before quoting a number.**

Everything here is current and attributed. Where an older document disagrees with this file, **this
file wins** and the older document is wrong. Retired rules are listed at the bottom on purpose, so
nobody reintroduces one by finding it somewhere else.

Superseded by this file: `COPY-RULES.md`, `AGENT-DOCTRINE.md`, `MESSAGING_AND_CONTENT.md`,
`SALES-PLAYBOOK.md` and `PHYSICIAN-FAQ.md` remain useful as background and examples, but any rule in
them that contradicts this file is dead.

---

## 1. Who Eric is, and what he is not

**Eric Weiscarger is a consultant** to the practices he works with, on their workers' compensation
pharmacy programme. **MDconcierge is not a pharmacy and does not practise medicine.**

That is not modesty, it is the whole footing of the business, and it decides what may and may not be
said. Every physician-facing document carries a notice saying it.

## 2. Never tell a physician what to prescribe

**Eric, 2026-09-02: "never tell a physician what to do."**

Anything that leaves here may:

- **report** what the pharmacy actually received, by date, drug, quantity and amount
- **set out** what the programme carries, its strengths, its pack sizes and the practice share
- **ask** a question, including asking a prescriber to authorise something
- **explain routing** in the EHR, and flag a pack size that is not a programme size

It may never:

- say or imply what to prescribe, for whom, in what combination, or instead of what
- carry "every order", "no exceptions", "you should", "what to send next time"
- put *same therapeutic benefit* next to *more money* in any form
- assert that two medicines are interchangeable, or that a combination is safe, unsafe or redundant

**Clinical questions go to the pharmacist**, whose job that is. Not to me, and not into the document.
The same rule covers staff-facing material: routing and pack sizes are fair game, prescribing is not.

## 3. Nothing sends, and nothing is incorporated, without Eric

Two halves, and the second is the one that gets broken.

1. **Nothing sends.** Draft it and wait for an explicit yes. Describing what he wants is not permission.
2. **Nothing is incorporated.** Do not write proposed copy into a template, a page or an edge
   function, and above all do not commit or push it, until he has read that exact wording and said
   yes. Authorising the *work* is not approving the *output*.
3. **Scope is his too.** Being handed exact wording approves that wording and nothing around it.
   Which touches it lands on, where it sits, and what changes with it are separate decisions and all
   his. Offer the options, then stop.

Mechanical repair of a verified defect is fine ungated. New or reworded copy is not. Reading his
inbox, the CRM and internal queries stay ungated.

---

## 4. The parties, named correctly

Eric, 2026-09-01: *"select Excel Pharmacy in Haverford, PA as the pharmacy, not MDRx. MDRx is the
billing and collections arm."*

| | What it is |
|---|---|
| **Excel Pharmacy** | The pharmacy. Dispenses and ships. 354 W Lancaster Ave, Suite 120, Haverford, PA 19041. Phone 877 272 7983, fax 877 274 1122. |
| **MDRx** | Billing and collections. Not a pharmacy. Named in copy; it is credibility, not a jolt to manage. |
| **PDRx** | The other pharmacy lane. Licensed in 49 states, operating in 37+. |
| **Elite Care** | PDRx's billing and collections arm. The physician assigns it the right to bill and collect. |

**In cold outreach, do not name the pharmacy.** Say "one of our in-network pharmacies" or "an
independent, licensed mail-order pharmacy." **Name Excel freely** in prescribing instructions and
anything operational, because the office has to find it in the EHR.

**MDRx is deliberately not vertically integrated** — billing, fulfilment and supply stay separate,
which supports a cleaner compliance framework. Eric, 2026-09-03: **use this only once a lead is
engaged.** It does not belong in cold touches or in a first document.

**MDRx's own pages and documents are theirs.** Eric has no authority to reword them. Frame them from
our side; do not edit a line.

## 5. Lanes

- **MDRx is Pennsylvania.** Out-of-state leads are **PDRx** and never enter the MDRx cold cadence.
- **PDRx operates in 37+ states**, so a relationship anywhere is in play on that lane.
- The Pennsylvania Supreme Court material (700 Pharmacy, Siegel, Gosfield) is **Pennsylvania only**.
  A rep repeating it out of state is wrong.

---

## 6. The cadence

**The sequence is the spacing.** Eric, 2026-09-02: *"kill my rule, follow the sequence."*

| After touch | Next touch is due |
|---|---|
| 1 | 3 days |
| 2 | 5 days |
| 3 | 7 days |
| past the end, or not in the sequence | 7 days |

Enforced at the wire in `send-outreach`, measured from **the later of the last send and
`last_touch_at`**, so a lead Eric answered by hand counts. A row that is early is never dropped; it
is given the date it may go on and sends itself then.

**Send window: before clinic, 06:30 to 07:30 Eastern, and nothing else.** Eric, 2026-09-03:
*"going forward it is before clinic for all automation."* The lunch window has been removed from
`outreach_config.send_windows` entirely rather than left as a fallback the wire can drift into,
which is exactly how a batch ended up at midday.

**The queue goes out daily.** If a morning passes with nothing sent, that is a fault, not a quiet
day. Schedules run every day in cron and stop themselves at the weekend inside the job, because
weekday-restricted crons were silently not firing.

**Several people at one practice on the same day is fine.** Three per practice per run.

## 7. The opt-out

One line, Eric's words, below the signature, on every campaign email:

> I don't want to bother you if not interested, **click here** if you would no longer like to hear
> from me.

- It is added by the queue builder and rendered as the small grey footer under the signature block.
- A **one to one** email carries **no** opt-out. A personal note is not marketing, and an
  unsubscribe under it says otherwise.
- Both gates recognise it by wording **and** by the unsubscribe link, so rewording it cannot silently
  stop the mail again. It has, twice.

## 8. Copy

- **Subjects short and lowercase.** `what changed in june`. Where a thread exists, its subject wins.
- **Lead with the patient**, then admin relief, then the practice's participation, then how little
  changes, then how they participate.
- **One email per physician.** Never address two people in one note.
- **Never reveal tracking.** Not "I saw you had a chance to look."
- **Never mention office dispensing.** It is banned in Pennsylvania work comp and it raises an
  objection the physician did not have. The programme is 100% mail order.
- **Never British spelling.** Authorization, organization, recognize.
- **Never em or en dashes.** Periods and commas. Ranges in words.
- **Never** "checking in", "circling back", "following up", "touching base", "any thoughts".
- **Never invent** a number, a name, a legal conclusion or a claim about their business.
- **Fits a phone screen.**

**Facts Eric is the source for. Do not hedge them and do not ask him to verify them again:**
hundreds of physicians already participate; if the prescription comes in it gets dispensed;
delivery is overnight to the patient's home; the programme is 100% mail order on the state fee
schedule.

---

## 9. Economics

Let **C** = amounts collected, **G** = cost of goods.

**Dispensing and shipping: $6.50 average per medication.** Eric, 2026-09-03: *"6.50 is average,
that's what we are going with."* Applied per medication across every tool and every quote.

**MDRx.** The physician's entity pays for the medication up front and receives **65 percent of what
is collected**; MDRx retains 35 percent and bears the billing and collection risk.
> Net to physician = **0.65C − G**

**PDRx / Elite Care.** Gross collections, less **claim purchase fees** — the wholesale cost of the
medication, a **$5.00** pharmacy dispense fee and actual shipping of **$7 to $10** — gives **net
income**. Elite Care's **management fee is 50 percent of net income**; the practice keeps the rest.
Claim purchase fees are deducted from collections, averaging 60 days, so nothing is paid up front.
> Net to practice = **0.5 × (C − G)**

**MDRx is the only one where the physician bears 100 percent of cost of goods.** At a 65 percent
split with COGS off the top, MDRx cannot win on economics at any mix. Getting the COGS treatment
wrong flips the answer.

**Advising between them:** ask whether the practice can comfortably front about 60 days of medication
cost. **No → PDRx**, no capital at risk. **Yes →** run their actual top drugs against both. Recommend
one, name the other, say why. Where a physician has already spoken to the other party, say so openly.

**Fee schedules are per state.** Pennsylvania is AWP **plus** 10 percent. Michigan is AWP **minus**
10 percent plus a dispensing fee, $5.50 generic and $8.50 topical. Never price one state's basket on
another state's rule.

**Never promise an amount.** The carrier decides what it pays and when.

## 10. What only Eric decides

Copy, in his words. Which touches carry what. Pricing and economics. Which lane a lead is in. Whether
anything sends. Anything legal. Anything clinical goes to the pharmacist, not to him and not to me.

---

## 11. Retired. Do not bring these back.

- ~~"Never email the same person twice in a week."~~ Retired 2026-09-02. **The sequence is the spacing.**
- ~~"Every email closes by asking to be pointed at the right person, on all five touches."~~ Retired
  2026-09-01. It appears on **touch five only**; the blanket append was the loudest tell that these
  were automated.
- ~~"One exit in the footer, touch five keeps it in the body."~~ Retired 2026-09-02, replaced by the
  single line in section 7, the same on all five.
- ~~The lunch send window.~~ Removed 2026-09-03. Before clinic only.
- ~~"PA Court Opens Up Significant Revenue Opportunity for Physicians"~~ as a subject line. Retired;
  it reads as a press release, which is what it was.
- ~~Comparable-medications / substitution suggestions.~~ Killed by Eric. See section 2.
