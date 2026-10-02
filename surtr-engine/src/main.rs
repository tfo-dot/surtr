use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use notify::{EventKind, RecursiveMode, Watcher};
use petgraph::Directed;
use petgraph::stable_graph::{NodeIndex, StableGraph};
use petgraph::visit::EdgeRef;
use pulldown_cmark::{Event, Parser};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use surtr_protocol::{
    Frontmatter, LoreRequest, LoreResponse, Namespace, Node, recv_frame, send_frame,
};
use tokio::net::UnixListener;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

const SOCKET_PATH: &str = "/tmp/surtr_engine.sock";
static READ_ONLY: AtomicBool = AtomicBool::new(false);

pub struct LoreGraph {
    pub graph: StableGraph<Node, (), Directed>,
    pub index: HashMap<(String, String), NodeIndex>,
}

impl LoreGraph {
    pub fn new() -> Self {
        Self {
            graph: StableGraph::new(),
            index: HashMap::new(),
        }
    }

    pub fn upsert_node(
        &mut self,
        vault_id: String,
        node_id: String,
        namespace: Namespace,
        metadata: Frontmatter,
        content: String,
        outgoing_links: Vec<String>,
    ) {
        let node_key = (vault_id.clone(), node_id.clone());
        let node_idx = if let Some(&idx) = self.index.get(&node_key) {
            if let Some(node) = self.graph.node_weight_mut(idx) {
                node.namespace = namespace;
                node.metadata = metadata;
                node.content = content;
            }
            idx
        } else {
            let node = Node {
                id: node_id.clone(),
                vault_id: vault_id.clone(),
                namespace,
                metadata,
                content,
            };
            let idx = self.graph.add_node(node);
            self.index.insert(node_key, idx);
            idx
        };

        // Remove existing outgoing edges from this node
        let mut to_remove = Vec::new();
        for edge in self.graph.edges(node_idx) {
            to_remove.push(edge.id());
        }
        for edge_id in to_remove {
            self.graph.remove_edge(edge_id);
        }

        // Add new outgoing edges
        for target_id in outgoing_links {
            let target_key = (vault_id.clone(), target_id.clone());
            let target_idx = if let Some(&t_idx) = self.index.get(&target_key) {
                t_idx
            } else {
                // Create placeholder node
                let placeholder = Node {
                    id: target_id.clone(),
                    vault_id: vault_id.clone(),
                    namespace: Namespace::Global,
                    metadata: Frontmatter::default(),
                    content: String::new(),
                };
                let t_idx = self.graph.add_node(placeholder);
                self.index.insert(target_key, t_idx);
                t_idx
            };
            self.graph.add_edge(node_idx, target_idx, ());
        }
    }

    pub fn delete_node(&mut self, vault_id: &str, node_id: &str) {
        let key = (vault_id.to_string(), node_id.to_string());
        if let Some(idx) = self.index.remove(&key) {
            self.graph.remove_node(idx);
        }
    }

    pub fn get_node(&self, vault_id: &str, node_id: &str) -> Option<Node> {
        let key = (vault_id.to_string(), node_id.to_string());
        self.index
            .get(&key)
            .and_then(|&idx| self.graph.node_weight(idx).cloned())
    }

    pub fn get_vault_nodes(&self, vault_id: &str) -> Vec<Node> {
        self.graph
            .node_weights()
            .filter(|node| node.vault_id == vault_id)
            .cloned()
            .collect()
    }
}

fn get_lore_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap();
    PathBuf::from(home).join("lore")
}

fn parse_path(lore_root: &Path, path: &Path) -> Option<(String, String, Namespace)> {
    let relative = path.strip_prefix(lore_root).ok()?;
    let mut components = relative.components();

    let vault_id = components.next()?.as_os_str().to_str()?.to_string();

    let namespace_str = components.next()?.as_os_str().to_str()?;
    let namespace = Namespace::from_str(namespace_str);

    // Remaining components: Node ID
    let remainder = components.as_path();
    if remainder.as_os_str().is_empty() {
        return None;
    }

    if remainder.extension()?.to_ascii_lowercase() == "md" {
        let node_id = remainder.with_extension("").to_string_lossy().to_string();
        Some((vault_id, node_id, namespace))
    } else {
        None
    }
}

fn parse_markdown_content(content: &str) -> (Frontmatter, String) {
    let content_trimmed = content.trim_start();
    if !content_trimmed.starts_with("---") {
        return (Frontmatter::default(), content.to_string());
    }

    let rest = &content_trimmed[3..];

    if let Some(end_idx) = rest.find("---") {
        let yaml_part = &rest[..end_idx];
        let prose_part = &rest[end_idx + 3..];

        match serde_yaml::from_str::<Frontmatter>(yaml_part) {
            Ok(frontmatter) => (frontmatter, prose_part.trim().to_string()),
            Err(e) => {
                eprintln!("Warning: YAML parsing failed: {}", e);
                (Frontmatter::default(), prose_part.trim().to_string())
            }
        }
    } else {
        (Frontmatter::default(), content.to_string())
    }
}

fn extract_wiki_links(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut start = 0;
    while let Some(open_idx) = text[start..].find("[[") {
        let absolute_open = start + open_idx;
        if let Some(close_idx) = text[absolute_open + 2..].find("]]") {
            let absolute_close = absolute_open + 2 + close_idx;
            let inner = &text[absolute_open + 2..absolute_close].trim();
            if !inner.is_empty() {
                links.push(inner.to_string());
            }

            start = absolute_close + 2;
        } else {
            break;
        }
    }
    links
}

fn extract_links_from_markdown(markdown: &str) -> Vec<String> {
    let parser = Parser::new(markdown);
    let mut accumulated = String::new();
    let mut in_code_block = false;
    for event in parser {
        match event {
            Event::Start(pulldown_cmark::Tag::CodeBlock(_)) => {
                in_code_block = true;
            }
            Event::End(pulldown_cmark::TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Text(text) => {
                if !in_code_block {
                    accumulated.push_str(&text);
                }
            }
            _ => {}
        }
    }
    let mut links = extract_wiki_links(&accumulated);
    links.sort();
    links.dedup();
    links
}

fn get_continuation_link(metadata: &Frontmatter) -> Option<String> {
    if let Some(val) = metadata.extra.get("continuation") {
        if let Some(cont_str) = val.as_str() {
            return Some(cont_str.to_string());
        }
    }
    None
}

fn scan_lore_dir(lore_root: &Path, graph: &mut LoreGraph) {
    if !lore_root.exists() {
        let _ = std::fs::create_dir_all(lore_root);
        return;
    }

    fn visit_dirs(dir: &Path, lore_root: &Path, graph: &mut LoreGraph) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();

                if path.is_symlink() {
                    continue;
                }

                if path.is_dir() {
                    visit_dirs(&path, lore_root, graph);
                    continue;
                }

                parse_file(lore_root, &path, graph);
            }
        }
    }

    visit_dirs(lore_root, lore_root, graph);
}

fn parse_file(lore_root: &Path, path: &PathBuf, graph: &mut LoreGraph) {
    if let Some((vault_id, node_id, namespace)) = parse_path(lore_root, &path) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let (metadata, prose) = parse_markdown_content(&content);
            let mut links = extract_links_from_markdown(&prose);

            if let Some(cont) = get_continuation_link(&metadata) {
                links.push(cont);
            }

            graph.upsert_node(vault_id, node_id, namespace, metadata, prose, links);
        }
    }
}

fn start_file_watcher(
    lore_root: PathBuf,
    graph: Arc<RwLock<LoreGraph>>,
) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.blocking_send(event);
            }
        })?;

    watcher.watch(&lore_root, RecursiveMode::Recursive)?;

    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            for path in event.paths {
                let lore_root_clone = lore_root.clone();
                let graph_clone = graph.clone();

                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        let mut g = graph_clone.write().await;
                        parse_file(&lore_root_clone, &path, &mut g);
                    }
                    EventKind::Remove(_) => {
                        if let Some((vault_id, node_id, _)) = parse_path(&lore_root_clone, &path) {
                            let mut g = graph_clone.write().await;
                            g.delete_node(&vault_id, &node_id);
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    Ok(watcher)
}

async fn run_http_server(
    graph: Arc<RwLock<LoreGraph>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let app = Router::new()
        .route("/api/vaults", get(api_list_vaults).post(api_create_vault))
        .route("/api/vaults/:vault/graph", get(api_get_graph))
        .route("/api/vaults/:vault/nodes", get(api_list_nodes))
        .route("/api/vaults/:vault/search", get(api_search_nodes))
        .route(
            "/api/vaults/:vault/nodes/*id",
            get(api_get_node)
                .post(api_save_node)
                .delete(api_delete_node),
        )
        .route("/api/vaults/:vault/inbox", post(api_add_inbox))
        .route("/api/vaults/:vault/assets", get(api_list_assets))
        .route(
            "/api/vaults/:vault/assets/*filename",
            post(api_upload_asset),
        )
        .route("/api/vaults/:vault/analytics", get(api_vault_analytics))
        .route("/api/vaults/:vault/assets/diagnostics", get(api_assets_diagnostics))
        .route("/api/vaults/:vault/assets/clean", post(api_assets_clean))
        .route("/api/vaults/:vault/rename", post(api_rename_node))
        .route("/api/vaults/:vault/export", get(api_export_vault))
        .route("/api/sync", patch(api_sync))
        .nest_service("/vaults", ServeDir::new(get_lore_root()))
        .fallback_service(ServeDir::new("surtr-engine/static"))
        .layer(CorsLayer::permissive())
        .with_state(graph);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await?;
    println!("HTTP Server listening on: http://127.0.0.1:8080");
    axum::serve(listener, app).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct CreateVaultPayload {
    name: String,
}

async fn api_create_vault(
    Json(payload): Json<CreateVaultPayload>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }
    let name = payload.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Vault name cannot be empty".to_string()));
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return Err((
            StatusCode::BAD_REQUEST,
            "Vault name must contain only alphanumeric characters, dashes, or underscores".to_string(),
        ));
    }

    let lore_root = get_lore_root();
    let vault_dir = lore_root.join(name);
    if vault_dir.exists() {
        return Err((StatusCode::CONFLICT, "Vault already exists".to_string()));
    }

    let dirs = [
        "global",
        "inbox",
        "story",
        "character",
        "location",
        "definition",
        "topics",
        "assets",
    ];

    for d in &dirs {
        let dir_path = vault_dir.join(d);
        if let Err(e) = tokio::fs::create_dir_all(&dir_path).await {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create folder '{}': {}", d, e),
            ));
        }
    }

    Ok(Json(format!("Vault '{}' created successfully", name)))
}

#[derive(serde::Serialize)]
struct SearchResult {
    id: String,
    namespace: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    snippet: String,
}

fn make_snippet(content: &str, query: &str) -> String {
    let lower_content = content.to_lowercase();
    let lower_query = query.to_lowercase();
    
    if let Some(idx) = lower_content.find(&lower_query) {
        let char_indices: Vec<(usize, char)> = content.char_indices().collect();
        let query_char_len = query.chars().count();
        
        let start_char_idx = char_indices.iter().position(|&(b_idx, _)| b_idx == idx).unwrap_or(0);
        let end_char_idx = start_char_idx + query_char_len;
        
        let context_before = 30;
        let context_after = 30;
        
        let slice_start_char = start_char_idx.saturating_sub(context_before);
        let slice_end_char = std::cmp::min(char_indices.len(), end_char_idx + context_after);
        
        if char_indices.is_empty() {
            return String::new();
        }
        
        let byte_start = char_indices[slice_start_char].0;
        let byte_end = if slice_end_char < char_indices.len() {
            char_indices[slice_end_char].0
        } else {
            content.len()
        };
        
        let prefix = if slice_start_char > 0 { "..." } else { "" };
        let suffix = if slice_end_char < char_indices.len() { "..." } else { "" };
        
        format!("{}{}{}", prefix, &content[byte_start..byte_end].replace('\n', " "), suffix)
    } else {
        let char_indices: Vec<(usize, char)> = content.char_indices().collect();
        if char_indices.is_empty() {
            String::new()
        } else {
            let limit = std::cmp::min(char_indices.len(), 60);
            let byte_end = if limit < char_indices.len() { char_indices[limit].0 } else { content.len() };
            let suffix = if limit < char_indices.len() { "..." } else { "" };
            format!("{}{}", &content[..byte_end].replace('\n', " "), suffix)
        }
    }
}

async fn api_search_nodes(
    AxumPath(vault): AxumPath<String>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<Vec<SearchResult>>, (StatusCode, String)> {
    let q = params.get("q").cloned().unwrap_or_default().trim().to_lowercase();
    if q.is_empty() {
        return Ok(Json(vec![]));
    }

    let g = graph.read().await;
    let mut results = Vec::new();

    for idx in g.graph.node_indices() {
        if let Some(node) = g.graph.node_weight(idx) {
            if node.vault_id == vault {
                let id_match = node.id.to_lowercase().contains(&q);
                let title_match = node.metadata.title.as_ref().map(|t| t.to_lowercase().contains(&q)).unwrap_or(false);
                let content_match = node.content.to_lowercase().contains(&q);
                let tags_match = node.metadata.tags.as_ref().map(|tags| {
                    tags.iter().any(|t| t.to_lowercase().contains(&q))
                }).unwrap_or(false);

                if id_match || title_match || content_match || tags_match {
                    let snippet = make_snippet(&node.content, &q);
                    results.push(SearchResult {
                        id: node.id.clone(),
                        namespace: node.namespace.to_string(),
                        title: node.metadata.title.clone(),
                        tags: node.metadata.tags.clone(),
                        snippet,
                    });
                }
            }
        }
    }

    results.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Json(results))
}

async fn api_list_vaults() -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let root = get_lore_root();
    let mut vaults = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    if !name.starts_with('.') {
                        vaults.push(name.to_string());
                    }
                }
            }
        }
    }
    vaults.sort();
    Ok(Json(vaults))
}

async fn api_sync() -> Result<Json<GraphResponse>, (StatusCode, String)> {
    return Ok(Json(GraphResponse {
        nodes: vec![],
        edges: vec![],
    }));
}

#[derive(serde::Serialize)]
struct GraphNode {
    id: String,
    namespace: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    has_file: bool,
    metadata: Option<Frontmatter>,
}

#[derive(serde::Serialize)]
struct GraphEdge {
    source: String,
    target: String,
}

#[derive(serde::Serialize)]
struct GraphResponse {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

async fn api_get_graph(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<GraphResponse>, (StatusCode, String)> {
    let g = graph.read().await;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let lore_root = get_lore_root();

    for idx in g.graph.node_indices() {
        if let Some(node) = g.graph.node_weight(idx) {
            if node.vault_id == vault {
                let ns_dir = node.namespace.to_string();
                let file_path = lore_root
                    .join(&vault)
                    .join(&ns_dir)
                    .join(format!("{}.md", node.id));
                let has_file = file_path.exists();

                nodes.push(GraphNode {
                    id: node.id.clone(),
                    namespace: node.namespace.to_string(),
                    title: node.metadata.title.clone(),
                    tags: node.metadata.tags.clone(),
                    has_file,
                    metadata: Some(node.metadata.clone()),
                });

                for edge in g.graph.edges(idx) {
                    let target_idx = edge.target();
                    if let Some(target_node) = g.graph.node_weight(target_idx) {
                        if target_node.vault_id == vault {
                            edges.push(GraphEdge {
                                source: node.id.clone(),
                                target: target_node.id.clone(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(Json(GraphResponse { nodes, edges }))
}

async fn api_list_nodes(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<Vec<GraphNode>>, (StatusCode, String)> {
    let g = graph.read().await;
    let mut nodes = Vec::new();
    let lore_root = get_lore_root();

    for idx in g.graph.node_indices() {
        if let Some(node) = g.graph.node_weight(idx) {
            if node.vault_id == vault {
                let ns_dir = node.namespace.to_string();
                let file_path = lore_root
                    .join(&vault)
                    .join(&ns_dir)
                    .join(format!("{}.md", node.id));
                let has_file = file_path.exists();

                nodes.push(GraphNode {
                    id: node.id.clone(),
                    namespace: node.namespace.to_string(),
                    title: node.metadata.title.clone(),
                    tags: Some(node.metadata.tags.clone().unwrap_or(vec![])),
                    has_file,
                    metadata: Some(node.metadata.clone()),
                });
            }
        }
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Json(nodes))
}

async fn api_get_node(
    AxumPath((vault, id)): AxumPath<(String, String)>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<Node>, (StatusCode, String)> {
    let g = graph.read().await;
    if let Some(node) = g.get_node(&vault, &id) {
        Ok(Json(node))
    } else {
        Err((
            StatusCode::NOT_FOUND,
            format!("Node '{}' not found in vault '{}'", id, vault),
        ))
    }
}

#[derive(serde::Deserialize)]
struct SaveNodePayload {
    namespace: String,
    metadata: Frontmatter,
    content: String,
}

async fn api_save_node(
    AxumPath((vault, id)): AxumPath<(String, String)>,
    Json(payload): Json<SaveNodePayload>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }
    let lore_root = get_lore_root();
    let ns = Namespace::from_str(&payload.namespace);
    let ns_dir = ns.to_string();

    let file_path = lore_root
        .join(&vault)
        .join(&ns_dir)
        .join(format!("{}.md", id));

    if let Some(parent) = file_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create directory structure: {}", e),
            ));
        }
    }

    let file_content = serialize_node_to_markdown(&payload.metadata, &payload.content);

    if let Err(e) = tokio::fs::write(&file_path, &file_content).await {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write file: {}", e),
        ))
    } else {
        Ok(Json("Node saved successfully".to_string()))
    }
}

fn serialize_node_to_markdown(metadata: &Frontmatter, content: &str) -> String {
    let mut output = String::new();
    if metadata.title.is_some() || metadata.tags.is_some() || !metadata.extra.is_empty() {
        output.push_str("---\n");
        if let Ok(yaml) = serde_yaml::to_string(metadata) {
            output.push_str(yaml.trim());
            output.push('\n');
        }
        output.push_str("---\n");
    }
    output.push_str(content);
    output
}

async fn api_delete_node(
    AxumPath((vault, id)): AxumPath<(String, String)>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }
    let g = graph.read().await;
    if let Some(node) = g.get_node(&vault, &id) {
        let ns_dir = node.namespace.to_string();
        let file_path = get_lore_root()
            .join(&vault)
            .join(&ns_dir)
            .join(format!("{}.md", id));

        if file_path.exists() {
            if let Err(e) = tokio::fs::remove_file(&file_path).await {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to delete file: {}", e),
                ));
            }
        }
        Ok(Json("Node deleted successfully".to_string()))
    } else {
        Err((StatusCode::NOT_FOUND, format!("Node '{}' not found", id)))
    }
}

#[derive(serde::Deserialize)]
struct AddInboxPayload {
    content: String,
}

async fn api_add_inbox(
    AxumPath(vault): AxumPath<String>,
    Json(payload): Json<AddInboxPayload>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }
    let lore_root = get_lore_root();
    let inbox_dir = lore_root.join(&vault).join("inbox");
    if let Err(e) = tokio::fs::create_dir_all(&inbox_dir).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create inbox directory: {}", e),
        ));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let file_name = format!("inbox_{}.md", now);
    let file_path = inbox_dir.join(file_name);

    if let Err(e) = tokio::fs::write(&file_path, &payload.content).await {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write inbox file: {}", e),
        ))
    } else {
        Ok(Json("Inbox entry saved successfully".to_string()))
    }
}

async fn api_list_assets(
    AxumPath(vault): AxumPath<String>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let lore_root = get_lore_root();
    let assets_dir = lore_root.join(&vault).join("assets");
    let mut assets = Vec::new();
    if assets_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(assets_dir) {
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    if let Some(name) = entry.file_name().to_str() {
                        assets.push(name.to_string());
                    }
                }
            }
        }
    }
    assets.sort();
    Ok(Json(assets))
}

async fn api_upload_asset(
    AxumPath((vault, filename)): AxumPath<(String, String)>,
    body: axum::body::Bytes,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }
    let lore_root = get_lore_root();
    let assets_dir = lore_root.join(&vault).join("assets");
    if let Err(e) = tokio::fs::create_dir_all(&assets_dir).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create assets directory: {}", e),
        ));
    }

    let file_path = assets_dir.join(&filename);

    // Validate directory traversal
    if !file_path.starts_with(&assets_dir) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid filename or directory traversal attempt".to_string(),
        ));
    }

    if let Err(e) = tokio::fs::write(&file_path, body).await {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write asset file: {}", e),
        ))
    } else {
        Ok(Json("Asset uploaded successfully".to_string()))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let is_read_only = args.iter().any(|arg| arg == "--read-only" || arg == "--player-mode");
    if is_read_only {
        READ_ONLY.store(true, Ordering::SeqCst);
        println!("Lore Engine started in READ-ONLY (PLAYER) mode.");
    }

    let lore_root = get_lore_root();
    println!("Initializing Lore Engine at: {}", lore_root.display());

    let graph = Arc::new(RwLock::new(LoreGraph::new()));

    // Initial Scan
    {
        let mut g = graph.write().await;
        scan_lore_dir(&lore_root, &mut g);
        println!("Initial scan completed. Indexed {} nodes.", g.index.len());
    }

    // Start File Watcher
    let _watcher = start_file_watcher(lore_root, graph.clone())?;
    println!("Kernel file watcher active.");

    // Start HTTP Server
    let graph_http = graph.clone();
    tokio::spawn(async move {
        if let Err(e) = run_http_server(graph_http).await {
            eprintln!("HTTP Server error: {}", e);
        }
    });

    // Clean up existing UDS socket
    if Path::new(SOCKET_PATH).exists() {
        let _ = std::fs::remove_file(SOCKET_PATH);
    }

    let listener = UnixListener::bind(SOCKET_PATH)?;
    println!("Lore Engine listening on UDS: {}", SOCKET_PATH);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let graph_clone = graph.clone();
                tokio::spawn(async move {
                    handle_client(stream, graph_clone).await;
                });
            }
            Err(e) => {
                eprintln!("UDS Accept error: {}", e);
            }
        }
    }
}

async fn handle_client(mut stream: tokio::net::UnixStream, graph: Arc<RwLock<LoreGraph>>) {
    loop {
        match recv_frame(&mut stream).await {
            Ok(req_bytes) => {
                let request: LoreRequest = match serde_json::from_slice(&req_bytes) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp =
                            LoreResponse::Error(format!("Failed to deserialize request: {}", e));
                        let resp_bytes = serde_json::to_vec(&resp).unwrap();
                        let _ = send_frame(&mut stream, &resp_bytes).await;
                        continue;
                    }
                };

                let response = match request {
                    LoreRequest::AddInbox { vault, content } => {
                        let lore_root = get_lore_root();
                        let inbox_dir = lore_root.join(&vault).join("inbox");
                        if let Err(e) = tokio::fs::create_dir_all(&inbox_dir).await {
                            LoreResponse::Error(format!("Failed to create inbox directory: {}", e))
                        } else {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_secs();
                            let file_name = format!("inbox_{}.md", now);
                            let file_path = inbox_dir.join(file_name);

                            match tokio::fs::write(&file_path, &content).await {
                                Ok(_) => LoreResponse::Success("Inbox entry saved.".to_string()),
                                Err(e) => LoreResponse::Error(format!(
                                    "Failed to write inbox file: {}",
                                    e
                                )),
                            }
                        }
                    }
                    LoreRequest::QueryNode { vault, identifier } => {
                        let g = graph.read().await;

                        if let Some(node) = g.get_node(&vault, &identifier) {
                            LoreResponse::NodeData(node)
                        } else {
                            LoreResponse::Error(format!(
                                "Node '{}' not found in vault '{}'",
                                identifier, vault
                            ))
                        }
                    }
                    LoreRequest::ListNodes { vault } => {
                        let g = graph.read().await;
                        let nodes = g.get_vault_nodes(&vault);
                        let node_ids = nodes.into_iter().map(|n| n.id).collect();
                        LoreResponse::NodeList(node_ids)
                    }
                    LoreRequest::CreateVault { vault } => {
                        let name = vault.trim();
                        if name.is_empty() {
                            LoreResponse::Error("Vault name cannot be empty".to_string())
                        } else if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                            LoreResponse::Error("Vault name must be alphanumeric or contain dashes/underscores".to_string())
                        } else {
                            let lore_root = get_lore_root();
                            let vault_dir = lore_root.join(name);
                            if vault_dir.exists() {
                                LoreResponse::Error(format!("Vault '{}' already exists", name))
                            } else {
                                let dirs = [
                                    "global",
                                    "inbox",
                                    "story",
                                    "character",
                                    "location",
                                    "definition",
                                    "topics",
                                    "assets",
                                ];
                                let mut success = true;
                                for d in &dirs {
                                    if let Err(e) = tokio::fs::create_dir_all(vault_dir.join(d)).await {
                                        success = false;
                                        eprintln!("Failed to create folder '{}': {}", d, e);
                                    }
                                }
                                if success {
                                    LoreResponse::Success(format!("Vault '{}' created successfully.", name))
                                } else {
                                    LoreResponse::Error(format!("Failed to create vault folder structure."))
                                }
                            }
                        }
                    }
                };

                let resp_bytes = match serde_json::to_vec(&response) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        let err_resp =
                            LoreResponse::Error(format!("Failed to serialize response: {}", e));
                        serde_json::to_vec(&err_resp).unwrap()
                    }
                };

                if let Err(e) = send_frame(&mut stream, &resp_bytes).await {
                    eprintln!("Error sending UDS response frame: {}", e);
                    break;
                }
            }
            Err(_) => {
                break; // Connection closed or error
            }
        }
    }
}

// === NEW API ENDPOINTS FOR ANALYTICS, ASSET GC, RENAMINGS, AND ARCHIVE EXPORTER ===

#[derive(serde::Deserialize)]
struct RenameNodePayload {
    old_id: String,
    new_id: String,
}

async fn api_vault_analytics(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let g = graph.read().await;
    
    let mut node_degrees: Vec<(String, usize)> = g.index.iter()
        .filter(|((v, _), _)| v == &vault)
        .map(|((_, id), &node_idx)| {
            let node = &g.graph[node_idx];
            let mut degree = 0;
            let out_links = node.content.split("[[").skip(1).count();
            degree += out_links;
            let incoming = g.graph.edges_directed(node_idx, petgraph::Incoming).count();
            degree += incoming;
            (id.clone(), degree)
        })
        .collect();
        
    node_degrees.sort_by(|a, b| b.1.cmp(&a.1));
    let top_hubs: Vec<serde_json::Value> = node_degrees.into_iter().take(5)
        .map(|(id, deg)| {
            serde_json::json!({
                "id": id,
                "degree": deg
            })
        })
        .collect();

    let mut story_graph = StableGraph::<String, (), Directed>::new();
    let mut node_indices = HashMap::new();

    for ((v, id), &node_idx) in &g.index {
        if v == &vault {
            let node = &g.graph[node_idx];
            let ns_str = node.namespace.to_string();
            if ns_str == "story" || ns_str == "stories" {
                let idx = story_graph.add_node(id.clone());
                node_indices.insert(id.clone(), idx);
            }
        }
    }

    for ((v, id), &node_idx) in &g.index {
        if v == &vault {
            let node = &g.graph[node_idx];
            if let Some(idx_src) = node_indices.get(id) {
                if let Some(cont_id) = node.metadata.extra.get("continuation").and_then(|v| v.as_str()) {
                    if let Some(idx_tgt) = node_indices.get(cont_id) {
                        story_graph.add_edge(*idx_src, *idx_tgt, ());
                    }
                }
            }
        }
    }

    let is_cyclic = petgraph::algo::is_cyclic_directed(&story_graph);

    let mut in_degrees = HashMap::new();
    for idx in story_graph.node_indices() {
        in_degrees.insert(idx, 0);
    }
    for edge_idx in story_graph.edge_indices() {
        if let Some((_, tgt)) = story_graph.edge_endpoints(edge_idx) {
            *in_degrees.entry(tgt).or_insert(0) += 1;
        }
    }

    let start_nodes: Vec<NodeIndex> = in_degrees.iter()
        .filter(|&(_, &deg)| deg == 0)
        .map(|(&idx, _)| idx)
        .collect();

    let mut reachable = std::collections::HashSet::new();
    for &start in &start_nodes {
        let mut dfs = petgraph::visit::Dfs::new(&story_graph, start);
        while let Some(node_idx) = dfs.next(&story_graph) {
            reachable.insert(node_idx);
        }
    }

    let mut unreachable_stories = Vec::new();
    for idx in story_graph.node_indices() {
        if !reachable.contains(&idx) && !start_nodes.contains(&idx) {
            unreachable_stories.push(story_graph[idx].clone());
        }
    }

    Ok(Json(serde_json::json!({
        "is_story_cyclic": is_cyclic,
        "unreachable_stories": unreachable_stories,
        "top_hubs": top_hubs,
        "read_only": READ_ONLY.load(Ordering::SeqCst)
    })))
}

async fn api_assets_diagnostics(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let lore_root = get_lore_root();
    let vault_dir = lore_root.join(&vault);
    let assets_dir = vault_dir.join("assets");

    if !assets_dir.exists() {
        return Ok(Json(serde_json::json!({
            "orphans": []
        })));
    }

    let mut all_assets = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&assets_dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    all_assets.insert(name.to_string());
                }
            }
        }
    }

    let g = graph.read().await;
    let mut referenced_assets = std::collections::HashSet::new();

    for ((v, _), &node_idx) in &g.index {
        if v == &vault {
            let node = &g.graph[node_idx];
            for asset in &all_assets {
                if node.content.contains(asset) {
                    referenced_assets.insert(asset.clone());
                }
            }

            if let Some(map_val) = node.metadata.extra.get("map") {
                if let Some(map_str) = map_val.as_str() {
                    referenced_assets.insert(map_str.to_string());
                }
            }
        }
    }

    let orphans: Vec<String> = all_assets.difference(&referenced_assets).cloned().collect();

    Ok(Json(serde_json::json!({
        "orphans": orphans
    })))
}

async fn api_assets_clean(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }

    let lore_root = get_lore_root();
    let vault_dir = lore_root.join(&vault);
    let assets_dir = vault_dir.join("assets");

    if !assets_dir.exists() {
        return Ok(Json("No assets folder found".to_string()));
    }

    let diag_result = api_assets_diagnostics(AxumPath(vault), State(graph)).await?;
    let orphans = diag_result.0.get("orphans")
        .and_then(|o| o.as_array())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to parse diagnostics".to_string()))?;

    let mut deleted_count = 0;
    for orphan_val in orphans {
        if let Some(orphan_name) = orphan_val.as_str() {
            let path = assets_dir.join(orphan_name);
            if path.exists() && path.starts_with(&assets_dir) {
                if let Ok(_) = std::fs::remove_file(path) {
                    deleted_count += 1;
                }
            }
        }
    }

    Ok(Json(format!("Clean complete. Deleted {} orphan assets.", deleted_count)))
}

async fn api_rename_node(
    AxumPath(vault): AxumPath<String>,
    State(graph): State<Arc<RwLock<LoreGraph>>>,
    Json(payload): Json<RenameNodePayload>,
) -> Result<Json<String>, (StatusCode, String)> {
    if READ_ONLY.load(Ordering::SeqCst) {
        return Err((StatusCode::FORBIDDEN, "Server is in read-only mode".to_string()));
    }

    let old_id = payload.old_id.trim();
    let new_id = payload.new_id.trim();

    if old_id.is_empty() || new_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Old ID and New ID cannot be empty".to_string()));
    }

    if old_id == new_id {
        return Ok(Json("No change needed".to_string()));
    }

    if !new_id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '/' || c == '-') {
        return Err((StatusCode::BAD_REQUEST, "Invalid new ID syntax".to_string()));
    }

    let lore_root = get_lore_root();
    let vault_dir = lore_root.join(&vault);

    let mut g = graph.write().await;

    if g.index.contains_key(&(vault.clone(), new_id.to_string())) {
        return Err((StatusCode::BAD_REQUEST, format!("Node '{}' already exists", new_id)));
    }

    let old_node_idx = g.index.get(&(vault.clone(), old_id.to_string()))
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Node '{}' not found", old_id)))?;

    let old_node = &g.graph[*old_node_idx];

    let ns_old = old_node.namespace.to_string();
    let old_file = vault_dir.join(&ns_old).join(format!("{}.md", old_id.replace("/", "_")));

    let ns_new = ns_old.clone();
    let new_file = vault_dir.join(&ns_new).join(format!("{}.md", new_id.replace("/", "_")));

    if !old_file.exists() {
        return Err((StatusCode::NOT_FOUND, "Original markdown file not found on disk".to_string()));
    }

    if let Some(parent) = new_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    if let Err(e) = std::fs::rename(&old_file, &new_file) {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to rename file: {}", e)));
    }

    for ((v, node_id), &node_idx) in &g.index {
        if v == &vault {
            if node_id == old_id {
                continue;
            }

            let node = &g.graph[node_idx];
            let ns = node.namespace.to_string();
            let note_path = vault_dir.join(&ns).join(format!("{}.md", node_id.replace("/", "_")));

            if note_path.exists() {
                if let Ok(content_str) = std::fs::read_to_string(&note_path) {
                    let mut modified = false;
                    let mut new_content = content_str.clone();

                    let target_link = format!("[[{}]]", old_id);
                    let replacement_link = format!("[[{}]]", new_id);
                    if new_content.contains(&target_link) {
                        new_content = new_content.replace(&target_link, &replacement_link);
                        modified = true;
                    }

                    let label_target = format!("]][[{}]]", old_id);
                    let label_replacement = format!("]][[{}]]", new_id);
                    if new_content.contains(&label_target) {
                        new_content = new_content.replace(&label_target, &label_replacement);
                        modified = true;
                    }

                    let cont_target = format!("continuation: {}", old_id);
                    let cont_replacement = format!("continuation: {}", new_id);
                    if new_content.contains(&cont_target) {
                        new_content = new_content.replace(&cont_target, &cont_replacement);
                        modified = true;
                    }

                    if modified {
                        let _ = std::fs::write(&note_path, new_content);
                    }
                }
            }
        }
    }

    g.index.clear();
    g.graph = StableGraph::new();
    scan_lore_dir(&vault_dir, &mut g);

    Ok(Json(format!("Node '{}' successfully renamed to '{}'", old_id, new_id)))
}

async fn api_export_vault(
    AxumPath(vault): AxumPath<String>,
) -> Result<impl axum::response::IntoResponse, (StatusCode, String)> {
    let lore_root = get_lore_root();
    let vault_dir = lore_root.join(&vault);

    if !vault_dir.exists() {
        return Err((StatusCode::NOT_FOUND, "Vault not found".to_string()));
    }

    let archive_name = format!("surtr_export_{}.tar.gz", vault);
    let archive_path = std::env::temp_dir().join(&archive_name);

    let output = std::process::Command::new("tar")
        .args(&[
            "-czf",
            archive_path.to_str().unwrap(),
            "-C",
            lore_root.to_str().unwrap(),
            &vault,
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            match tokio::fs::read(&archive_path).await {
                Ok(bytes) => {
                    let _ = std::fs::remove_file(&archive_path);

                    let content_disposition = format!("attachment; filename=\"{}\"", archive_name);
                    
                    use axum::http::header::{HeaderMap, HeaderValue, CONTENT_TYPE, CONTENT_DISPOSITION};
                    let mut headers = HeaderMap::new();
                    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/gzip"));
                    if let Ok(val) = HeaderValue::from_str(&content_disposition) {
                        headers.insert(CONTENT_DISPOSITION, val);
                    }
                    
                    Ok((headers, bytes))
                }
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to read compiled archive: {}", e),
                )),
            }
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Tar packing error: {}", err),
            ))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("System tar command execution failed: {}", e),
        )),
    }
}
