use clap::{Parser, Subcommand};
use surtr_protocol::{LoreRequest, LoreResponse, send_frame, recv_frame};
use tokio::net::UnixStream;

const SOCKET_PATH: &str = "/tmp/surtr_engine.sock";

#[derive(Parser)]
#[command(name = "lore-cli")]
#[command(about = "Microscopic CLI client for the Monolithic Vault Lore Engine", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Add prose content directly to the inbox of a vault
    AddInbox {
        /// Name of the vault
        vault: String,
        /// Prose content to write
        content: String,
    },
    /// Query a specific node inside a vault
    QueryNode {
        /// Name of the vault
        vault: String,
        /// Node identifier (filename without extension, e.g. "netrunner")
        identifier: String,
    },
    /// List all nodes in a vault
    ListNodes {
        /// Name of the vault
        vault: String,
    },
    /// Create a new lore vault
    CreateVault {
        /// Name of the vault to create
        vault: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Cli::parse();

    // Map args to LoreRequest
    let request = match args.command {
        Commands::AddInbox { vault, content } => LoreRequest::AddInbox { vault, content },
        Commands::QueryNode { vault, identifier } => LoreRequest::QueryNode { vault, identifier },
        Commands::ListNodes { vault } => LoreRequest::ListNodes { vault },
        Commands::CreateVault { vault } => LoreRequest::CreateVault { vault },
    };

    // Connect to the daemon UDS socket
    let mut stream = match UnixStream::connect(SOCKET_PATH).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error: Could not connect to Lore Engine at {}. Is the daemon running?", SOCKET_PATH);
            eprintln!("Details: {}", e);
            std::process::exit(1);
        }
    };

    // Serialize request
    let req_bytes = serde_json::to_vec(&request)?;

    // Send frame
    send_frame(&mut stream, &req_bytes).await?;

    // Read response frame
    let resp_bytes = recv_frame(&mut stream).await?;

    // Deserialize response
    let response: LoreResponse = serde_json::from_slice(&resp_bytes)?;

    // Process and display response
    match response {
        LoreResponse::Success(msg) => {
            println!("Success: {}", msg);
        }
        LoreResponse::Error(err) => {
            eprintln!("Error: {}", err);
            std::process::exit(1);
        }
        LoreResponse::NodeList(nodes) => {
            for node in nodes {
                println!("{}", node);
            }
        }
        LoreResponse::NodeData(node) => {
            println!("Vault:     {}", node.vault_id);
            println!("Namespace: {:?}", node.namespace);
            println!("ID:        {}", node.id);
            if let Some(title) = &node.metadata.title {
                println!("Title:     {}", title);
            }
            if let Some(tags) = &node.metadata.tags {
                println!("Tags:      {:?}", tags);
            }
            if !node.metadata.extra.is_empty() {
                println!("Metadata:");
                if let Ok(yaml) = serde_yaml::to_string(&node.metadata.extra) {
                    for line in yaml.lines() {
                        println!("  {}", line);
                    }
                }
            }
            println!("{}", "-".repeat(40));
            println!("{}", node.content);
        }
    }

    Ok(())
}
