//! Form elicitations (`elicitation/create`, mode `form`): questions the
//! agent asks mid-turn — Claude's AskUserQuestion multiple choice, a
//! refusal-fallback consent prompt, an MCP server's form. The request
//! carries a restricted JSON Schema; this parses the subset forms use into
//! fields the pane can render, and the answer goes back as
//! `{ action: "accept", content }` (or `decline` / `cancel`).

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

/// Where Claude's adapter tucks an option's preview (mockup, snippet).
const PREVIEW_META_KEY: &str = "_claude/askUserQuestionOption";

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpQuestion {
    /// The JSON-RPC request id, stringified — what the answer names.
    pub id: String,
    pub message: String,
    pub tool_call_id: Option<String>,
    pub fields: Vec<AcpFormField>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpFormField {
    /// Property name; the key in the answer's `content`.
    pub key: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub input: AcpFormInput,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AcpFormInput {
    /// Pick one (`multi: false`, answer is a string) or several (answer is
    /// an array of strings).
    Choice {
        multi: bool,
        options: Vec<AcpFormChoice>,
    },
    Text {
        multiline: bool,
    },
    Boolean,
    Number {
        integer: bool,
    },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpFormChoice {
    pub value: String,
    pub title: String,
    pub description: Option<String>,
    /// Claude's per-option preview (a mockup or code snippet), if any.
    pub preview: Option<String>,
}

/// Parse an `elicitation/create` request. `None` for URL-mode requests
/// and anything without a usable form.
pub fn parse_question(id: String, params: &Value) -> Option<AcpQuestion> {
    if params.get("mode").and_then(Value::as_str).unwrap_or("form") != "form" {
        return None;
    }
    let schema = params.get("requestedSchema")?;
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let fields: Vec<AcpFormField> = schema
        .get("properties")?
        .as_object()?
        .iter()
        .filter_map(|(key, prop)| {
            Some(AcpFormField {
                key: key.clone(),
                title: str_of(prop, "title"),
                description: str_of(prop, "description"),
                required: required.contains(&key.as_str()),
                input: parse_input(prop)?,
            })
        })
        .collect();
    if fields.is_empty() {
        return None;
    }
    Some(AcpQuestion {
        id,
        message: str_of(params, "message").unwrap_or_default(),
        tool_call_id: str_of(params, "toolCallId"),
        fields,
    })
}

fn parse_input(prop: &Value) -> Option<AcpFormInput> {
    match prop.get("type").and_then(Value::as_str)? {
        "string" => {
            let options = choices(prop);
            Some(if options.is_empty() {
                let multiline = prop
                    .get("maxLength")
                    .and_then(Value::as_u64)
                    .map_or(true, |n| n > 200);
                AcpFormInput::Text { multiline }
            } else {
                AcpFormInput::Choice {
                    multi: false,
                    options,
                }
            })
        }
        "array" => {
            let options = choices(prop.get("items")?);
            (!options.is_empty()).then_some(AcpFormInput::Choice {
                multi: true,
                options,
            })
        }
        "boolean" => Some(AcpFormInput::Boolean),
        "number" => Some(AcpFormInput::Number { integer: false }),
        "integer" => Some(AcpFormInput::Number { integer: true }),
        _ => None,
    }
}

/// Options from `oneOf` / `anyOf` (`{ const, title }`) or a bare `enum`
/// (with optional parallel `enumNames`).
fn choices(schema: &Value) -> Vec<AcpFormChoice> {
    let titled = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array);
    if let Some(list) = titled {
        return list
            .iter()
            .filter_map(|o| {
                let value = o.get("const").and_then(Value::as_str)?.to_string();
                Some(AcpFormChoice {
                    title: str_of(o, "title").unwrap_or_else(|| value.clone()),
                    description: str_of(o, "description"),
                    preview: o
                        .pointer(&format!(
                            "/_meta/{}/preview",
                            PREVIEW_META_KEY.replace('/', "~1")
                        ))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    value,
                })
            })
            .collect();
    }
    let names = schema.get("enumNames").and_then(Value::as_array);
    schema
        .get("enum")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, v)| {
            let value = v.as_str()?.to_string();
            Some(AcpFormChoice {
                title: names
                    .and_then(|n| n.get(i))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| value.clone()),
                description: None,
                preview: None,
                value,
            })
        })
        .collect()
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What Claude's adapter sends for two AskUserQuestion questions.
    fn ask_user_question() -> Value {
        json!({
            "mode": "form",
            "sessionId": "s",
            "toolCallId": "toolu_1",
            "message": "Please answer the following questions.",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "question_0": {
                        "type": "string", "title": "Storage", "description": "Which cache?",
                        "oneOf": [
                            { "const": "Redis", "title": "Redis", "description": "In-memory",
                              "_meta": { "_claude/askUserQuestionOption": { "preview": "redis://…" } } },
                            { "const": "None", "title": "None" },
                        ],
                    },
                    "question_0_custom": { "type": "string", "title": "Other", "description": "Type your own answer" },
                    "question_1": {
                        "type": "array", "title": "Targets",
                        "items": { "anyOf": [{ "const": "mac", "title": "macOS" }, { "const": "linux", "title": "Linux" }] },
                    },
                    "question_1_custom": { "type": "string", "title": "Other" },
                },
            },
        })
    }

    #[test]
    fn parses_ask_user_question_forms_in_order() {
        let q = parse_question("9".into(), &ask_user_question()).unwrap();
        assert_eq!(q.id, "9");
        assert_eq!(q.tool_call_id.as_deref(), Some("toolu_1"));
        let keys: Vec<_> = q.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "question_0",
                "question_0_custom",
                "question_1",
                "question_1_custom"
            ]
        );

        let AcpFormInput::Choice { multi, options } = &q.fields[0].input else {
            panic!()
        };
        assert!(!multi);
        assert_eq!(options[0].description.as_deref(), Some("In-memory"));
        assert_eq!(options[0].preview.as_deref(), Some("redis://…"));
        assert_eq!(options[1].description, None);
        assert_eq!(q.fields[1].input, AcpFormInput::Text { multiline: true });

        let AcpFormInput::Choice { multi, options } = &q.fields[2].input else {
            panic!()
        };
        assert!(*multi);
        assert_eq!(options[1].title, "Linux");
        assert_eq!(options[1].value, "linux");
    }

    #[test]
    fn parses_enums_booleans_numbers_and_required() {
        let q = parse_question(
            "1".into(),
            &json!({
                "message": "Configure",
                "requestedSchema": {
                    "type": "object",
                    "required": ["level"],
                    "properties": {
                        "level": { "type": "string", "enum": ["a", "b"], "enumNames": ["Alpha", "Beta"] },
                        "confirm": { "type": "boolean" },
                        "count": { "type": "integer" },
                        "name": { "type": "string", "maxLength": 40 },
                        "blob": { "type": "object" },
                    },
                },
            }),
        )
        .unwrap();
        assert_eq!(q.fields.len(), 4, "unsupported kinds are skipped");
        assert!(q.fields[0].required && !q.fields[1].required);
        let AcpFormInput::Choice { options, .. } = &q.fields[0].input else {
            panic!()
        };
        assert_eq!(options[1].title, "Beta");
        assert_eq!(q.fields[1].input, AcpFormInput::Boolean);
        assert_eq!(q.fields[2].input, AcpFormInput::Number { integer: true });
        assert_eq!(q.fields[3].input, AcpFormInput::Text { multiline: false });
    }

    #[test]
    fn ignores_url_mode_and_empty_forms() {
        assert!(
            parse_question("1".into(), &json!({ "mode": "url", "url": "https://x" })).is_none()
        );
        assert!(parse_question(
            "1".into(),
            &json!({ "requestedSchema": { "type": "object", "properties": {} } })
        )
        .is_none());
    }
}
