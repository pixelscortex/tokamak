//! Translate only our bundle's stack frames; host and unrelated scripts keep
//! their own locations. Source maps are build metadata, never executable code.

pub(crate) const BUNDLE_NAME: &str = "tokamak-bundle.js";

pub(crate) fn remap(stack: &str, bundle: &crate::Bundle, parser: bool) -> String {
    stack
        .lines()
        .take(64)
        .map(|frame| {
            let Some(map) = bundle.map.as_ref() else {
                return frame.to_owned();
            };
            let Some((prefix, rest)) = frame.split_once(&format!("{BUNDLE_NAME}:")) else {
                return frame.to_owned();
            };
            if !prefix.is_empty() && !prefix.ends_with(['(', ' ', '\t']) {
                return frame.to_owned();
            }
            let end = rest
                .find(|c: char| !c.is_ascii_digit() && c != ':')
                .unwrap_or(rest.len());
            let mut numbers = rest[..end].split(':');
            let line = numbers.next().and_then(|s| s.parse::<u32>().ok());
            let col = numbers.next().map(|s| s.parse::<u32>());
            let Some(line) = line.filter(|line| *line > 0) else {
                return frame.to_owned();
            };
            let col = match col {
                Some(Ok(col)) if col > 0 => Some(col),
                None => None,
                _ => return frame.to_owned(),
            };
            if numbers.next().is_some() {
                return frame.to_owned();
            }
            let columns = generated_columns(&bundle.source, line, col, parser);
            let mut locations = Vec::new();
            let mut has_mapping = false;
            for column in columns {
                let location = original_location(map, line, column);
                has_mapping |= location.is_some();
                let location = location.unwrap_or_else(|| {
                    format!("unmapped generated UTF-16 column {column} (zero-based)")
                });
                if !locations.contains(&location) {
                    locations.push(location);
                }
            }
            if !has_mapping {
                return frame.to_owned();
            }
            match locations.as_slice() {
                [location] if col.is_some() => {
                    format!("{prefix}{location}{}", &rest[end..])
                }
                [location] => format!(
                    "{frame}\n      [approximate source location (column unavailable): {location}]"
                ),
                _ => format!(
                    "{frame}\n      [ambiguous source locations: {}]",
                    locations.join(" | ")
                ),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// QuickJS-NG 0.16.2 has two byte-column origins. Normal lexer locations
/// are zero-based (clamped to one) on line 1 and one-based after LF. Parser
/// errors and TOK_IDENT's scope_get_var locations are explicitly one-based on
/// every line. The stack does not expose the instruction kind, so retain both
/// valid candidates instead of confidently selecting a potentially wrong TS
/// line. Do not infer instruction kinds from user-controlled exception messages.
/// Convert byte positions to Source Map v3's UTF-16 columns and deduplicate.
/// Reverify these engine-source rules when upgrading the bundled engine.
fn generated_columns(source: &str, line: u32, col: Option<u32>, parser: bool) -> Vec<u32> {
    let Some(col) = col else {
        return vec![0];
    };
    let Some(generated_line) = source.split('\n').nth((line - 1) as usize) else {
        return Vec::new();
    };
    let one_based = (col - 1) as usize;
    let lexer = if parser || line > 1 {
        one_based
    } else {
        col as usize
    };
    let mut columns = Vec::new();
    for bytes in [lexer, one_based] {
        // An offset inside a Unicode codepoint cannot locate a JS token.
        let Some(prefix) = generated_line.get(..bytes) else {
            continue;
        };
        let Ok(column) = u32::try_from(prefix.encode_utf16().count()) else {
            continue;
        };
        if !columns.contains(&column) {
            columns.push(column);
        }
    }
    columns
}

fn original_location(map: &sourcemap::SourceMap, line: u32, column: u32) -> Option<String> {
    let token = map.lookup_token(line - 1, column)?;
    // A token on a preceding generated line is not evidence about this line.
    if token.get_dst_line() != line - 1 {
        return None;
    }
    Some(format!(
        "{}:{}:{}",
        token.get_source()?,
        token.get_src_line().checked_add(1)?,
        token.get_src_col().checked_add(1)?
    ))
}
