//! Optional bounded raw facts. Unknown/unsafe rows always remain candidates.
//! Facts update in the SAME raw/record transaction and raw version fence.
use super::*;
use mdbn_core::views::bases::{BasesCandidate, BasesCandidateAtom, BasesCandidateCompare};
const MAX_FACTS: usize = 64;
const MAX_FACT_BYTES: usize = 65_536;

pub(super) fn delete(id: &[u8], out: &mut Vec<Stmt>) {
    for table in ["st_qraw_fact", "st_qraw_atom", "st_qraw_tag"] {
        out.push(Stmt::new(
            format!("DELETE FROM {table} WHERE id=?"),
            vec![blob(id)],
        ));
    }
}
pub(super) fn clear(out: &mut Vec<Stmt>) {
    for table in ["st_qraw_fact", "st_qraw_atom", "st_qraw_tag"] {
        out.push(Stmt::new(format!("DELETE FROM {table}"), vec![]));
    }
}
pub(super) fn capture(
    row: &RecordRow,
    document: &Document,
    tags: Option<&[String]>,
    out: &mut Vec<Stmt>,
) -> usize {
    delete(&row.id.0, out);
    let map = document.frontmatter();
    let size = map
        .iter()
        .map(|(k, v)| k.len() + v.as_str().map_or(0, str::len) + 64)
        .sum::<usize>()
        + tags.map_or(0, |ts| ts.iter().map(|t| t.len() + 64).sum::<usize>());
    let known = map.len() <= MAX_FACTS
        && tags.is_none_or(|ts| ts.len() <= MAX_FACTS)
        && size <= MAX_FACT_BYTES
        && mdbn_core::paths::check_path(&row.path).is_ok();
    out.push(Stmt::new(
        "INSERT INTO st_qraw_fact(id,known) VALUES(?,?)",
        vec![blob(&row.id.0), SqlValue::Integer(i64::from(known))],
    ));
    if !known {
        return 64;
    }
    for (name, value) in map.iter() {
        let (kind, text) = match BasesCandidateAtom::capture(value) {
            BasesCandidateAtom::Null => (0, ""),
            BasesCandidateAtom::Scalar => (1, ""),
            BasesCandidateAtom::Text(s) => (2, s),
            BasesCandidateAtom::DateOnly(s) => (3, s),
            BasesCandidateAtom::EmptyContainer => (4, ""),
            BasesCandidateAtom::Unknown => (5, ""),
        };
        out.push(Stmt::new(
            "INSERT INTO st_qraw_atom(id,name,kind,text) VALUES(?,?,?,?)",
            vec![
                blob(&row.id.0),
                blob(name.as_bytes()),
                SqlValue::Integer(kind),
                blob(text.as_bytes()),
            ],
        ));
    }
    if let Some(tags) = tags {
        for tag in tags {
            out.push(Stmt::new(
                "INSERT OR IGNORE INTO st_qraw_tag(id,tag) VALUES(?,?)",
                vec![
                    blob(&row.id.0),
                    blob(tag.trim_start_matches('#').as_bytes()),
                ],
            ));
        }
    }
    size
}
struct Builder {
    params: Vec<SqlValue>,
}
impl Builder {
    fn parameter(&mut self, bytes: &[u8]) -> String {
        self.params.push(blob(bytes));
        "?".into()
    }
    fn atom(&mut self, field: &str, expression: &str, missing: i64) -> String {
        let name = self.parameter(field.as_bytes());
        format!(
            "COALESCE((SELECT {expression} FROM st_qraw_atom a WHERE a.id=q.id AND a.name={name}),{missing})"
        )
    }
    fn lower(&mut self, p: &BasesCandidate) -> String {
        match p {
            BasesCandidate::Unknown=>"-1".into(),
            BasesCandidate::Constant(b)=>if *b {"1"} else {"0"}.into(),
            BasesCandidate::HasTag(tag)=> {
                let exact=self.parameter(tag.as_bytes());
                let lower=format!("{tag}/");
                let mut upper=lower.as_bytes().to_vec(); upper.push(255);
                let low=self.parameter(lower.as_bytes());
                let high=self.parameter(&upper);
                format!("CASE WHEN q.tags=X'f6' THEN -1 WHEN EXISTS(SELECT 1 FROM st_qraw_tag t WHERE t.id=q.id AND (t.tag={exact} OR (t.tag>={low} AND t.tag<{high}))) THEN 1 ELSE 0 END")
            },
            BasesCandidate::Empty{field,date_typed}=>self.atom(field,if *date_typed {"CASE a.kind WHEN 3 THEN 0 ELSE -1 END"} else {"CASE a.kind WHEN 0 THEN 1 WHEN 1 THEN 0 WHEN 2 THEN (length(a.text)=0) WHEN 3 THEN 0 WHEN 4 THEN 1 ELSE -1 END"},1),
            BasesCandidate::TextEqual{field,text}=> {
                // Parameter order follows SQL occurrence, not construction order.
                let text=self.parameter(text.as_bytes());
                self.atom(field,&format!("CASE WHEN a.kind IN (0,1,4) THEN 0 WHEN a.kind IN (2,3) THEN (a.text={text}) ELSE -1 END"),0)
            },
            BasesCandidate::DateDay{field,op,day}=> {
                let cmp=match op {BasesCandidateCompare::Eq=>"=",BasesCandidateCompare::Lt=>"<",BasesCandidateCompare::Le=>"<=",BasesCandidateCompare::Gt=>">",BasesCandidateCompare::Ge=>">="};
                let day=self.parameter(day.as_bytes());
                self.atom(field,&format!("CASE a.kind WHEN 3 THEN (a.text{cmp}{day}) ELSE -1 END"),-1)
            },
            BasesCandidate::And(a,b)=> {
                let a=self.lower(a); let b=self.lower(b);
                format!("CASE ({a}) WHEN 0 THEN 0 WHEN 1 THEN ({b}) ELSE -1 END")
            },
            BasesCandidate::Or(a,b)=> {
                let a=self.lower(a); let b=self.lower(b);
                format!("CASE ({a}) WHEN 1 THEN 1 WHEN 0 THEN ({b}) ELSE -1 END")
            },
            BasesCandidate::Not(a)=> {
                let a=self.lower(a);
                format!("CASE ({a}) WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE -1 END")
            },
        }
    }
}
pub(super) fn condition(p: &BasesCandidate) -> StoreResult<(String, Vec<SqlValue>)> {
    if !p.is_bounded() {
        return Err(StoreError::Full);
    }
    let mut b = Builder { params: vec![] };
    let expression = b.lower(p);
    if b.params.len() > 98
        || b.params
            .iter()
            .map(|v| match v {
                SqlValue::Blob(x) => x.len(),
                _ => 0,
            })
            .sum::<usize>()
            > 1 << 20
    {
        // This approximation cannot fit the existing parameter/byte budget.
        // Retain every raw row; never raise limits or hydrate whole sources.
        return Ok(("1".into(), vec![]));
    }
    Ok((
        format!(
            "(COALESCE((SELECT known FROM st_qraw_fact f WHERE f.id=q.id),0)=0 OR ({expression})!=0)"
        ),
        b.params,
    ))
}
