use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Namespace {
    Global,
    Inbox,
    Story,
    Character,
    Definition,
    Other(String),
}

impl Namespace {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "global" => Namespace::Global,
            "inbox" => Namespace::Inbox,
            "story" => Namespace::Story,
            "character" => Namespace::Character,
            "definition" => Namespace::Definition,
            other => Namespace::Other(other.to_string()),
        }
    }

    pub fn to_string(&self) -> String {
        match self {
            Namespace::Global => "global".to_string(),
            Namespace::Inbox => "inbox".to_string(),
            Namespace::Story => "story".to_string(),
            Namespace::Character => "character".to_string(),
            Namespace::Definition => "definition".to_string(),
            Namespace::Other(s) => s.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub vault_id: String,
    pub namespace: Namespace,
    pub metadata: Frontmatter,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LoreRequest {
    AddInbox { vault: String, content: String },
    QueryNode { vault: String, identifier: String },
    ListNodes { vault: String },
    CreateVault { vault: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LoreResponse {
    Success(String),
    NodeData(Node),
    NodeList(Vec<String>),
    Error(String),
}

// Helper functions for 4-byte big-endian length prefix framing
pub async fn send_frame<W>(writer: &mut W, data: &[u8]) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let len = data.len() as u32;
    writer.write_u32(len).await?;
    writer.write_all(data).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn recv_frame<R>(reader: &mut R) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let len = reader.read_u32().await?;
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).await?;
    Ok(buf)
}
