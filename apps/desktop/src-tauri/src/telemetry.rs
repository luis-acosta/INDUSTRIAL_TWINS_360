//! Proxy de telemetría.
//!
//! Es el único punto del producto que habla con InfluxDB, y existe para
//! cumplir dos exigencias de la arquitectura que no son negociables:
//!
//!  1. «UI no accede directamente a InfluxDB con token. Backend local/privado
//!     consulta con credenciales protegidas.» El token se lee aquí del almacén
//!     del sistema y no sale de este proceso.
//!  2. «La telemetría es exclusivamente lectura.» No hay ninguna función que
//!     escriba, y toda consulta pasa por un verificador que la rechaza si
//!     contiene palabras de escritura o de administración.
//!
//! El verificador no es decorativo. Flux permite `to()`, `delete`, `drop` y
//! llamadas HTTP salientes; una consulta construida a partir de un proyecto
//! importado podría intentar cualquiera de ellas. Que el usuario del token sea
//! de sólo lectura en el servidor es la primera defensa; esta es la segunda, y
//! la que no depende de cómo esté configurado el servidor del cliente.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use crate::secrets::read_secret;

/// Palabras que descalifican una consulta.
///
/// La lista cubre escritura de datos (`to`, `delete`), manipulación de
/// esquema (`drop`, `create`, `alter`) y salida de red desde el propio motor
/// (`http.post`, `sql.to`), que es la vía por la que una consulta podría
/// exfiltrar datos sin escribir nada en la base.
const FORBIDDEN: &[&str] = &[
    "to(",
    "delete(",
    "drop(",
    "create ",
    "alter ",
    "insert ",
    "update ",
    "grant ",
    "revoke ",
    "http.post",
    "http.get",
    "sql.to",
    "influxdb.to",
    "experimental.to",
];

#[derive(Debug, thiserror::Error)]
pub enum TelemetryError {
    #[error("La consulta contiene una operación que no es de lectura: {0}")]
    NotReadOnly(String),
    #[error("No se pudo leer la credencial del almacén del sistema: {0}")]
    Credential(String),
    #[error("El historiador no respondió: {0}")]
    Transport(String),
    #[error("El historiador respondió {status}")]
    Status { status: u16 },
}

impl Serialize for TelemetryError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Comprueba que la consulta sólo lee.
///
/// Se normaliza a minúsculas y se eliminan los espacios antes del paréntesis
/// para que `to (` y `TO(` no pasen el filtro: un verificador que se esquiva
/// con un espacio no verifica nada.
pub fn is_read_only(query: &str) -> Result<(), TelemetryError> {
    let normalized = query.to_ascii_lowercase().replace(" (", "(").replace('\t', " ");

    for word in FORBIDDEN {
        if normalized.contains(word) {
            return Err(TelemetryError::NotReadOnly((*word).to_string()));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct QueryRequest {
    /// URL base del servidor InfluxDB 2.x.
    pub url: String,
    pub org: String,
    /// Clave del secreto en el almacén del sistema. **No el token.**
    pub key_id: String,
    /// Consulta Flux. Se verifica antes de enviarse.
    pub flux: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    8_000
}

#[derive(Debug, Serialize)]
pub struct QueryResponse {
    /// Respuesta en CSV anotado, tal como la devuelve InfluxDB.
    pub csv: String,
    pub latency_ms: u64,
}

/// Ejecuta una consulta de lectura contra el historiador.
#[tauri::command]
pub async fn telemetry_query(request: QueryRequest) -> Result<QueryResponse, TelemetryError> {
    is_read_only(&request.flux)?;

    let token = read_secret(&request.key_id).map_err(|e| TelemetryError::Credential(e.to_string()))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(request.timeout_ms.clamp(500, 60_000)))
        // Sin redirecciones: una redirección llevaría la cabecera de
        // autorización a un servidor que el cliente no configuró.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| TelemetryError::Transport(e.to_string()))?;

    let started = Instant::now();
    let response = client
        .post(format!("{}/api/v2/query", request.url.trim_end_matches('/')))
        .query(&[("org", request.org.as_str())])
        .header("Authorization", format!("Token {token}"))
        .header("Content-Type", "application/vnd.flux")
        .header("Accept", "application/csv")
        .body(request.flux)
        .send()
        .await
        .map_err(|e| TelemetryError::Transport(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(TelemetryError::Status {
            status: status.as_u16(),
        });
    }

    let csv = response
        .text()
        .await
        .map_err(|e| TelemetryError::Transport(e.to_string()))?;

    Ok(QueryResponse {
        csv,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

/// Comprueba que el historiador responde, sin traer datos.
#[tauri::command]
pub async fn telemetry_ping(url: String, timeout_ms: u64) -> Result<u64, TelemetryError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(500, 60_000)))
        .build()
        .map_err(|e| TelemetryError::Transport(e.to_string()))?;

    let started = Instant::now();
    let response = client
        .get(format!("{}/ping", url.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| TelemetryError::Transport(e.to_string()))?;

    if !response.status().is_success() {
        return Err(TelemetryError::Status {
            status: response.status().as_u16(),
        });
    }
    Ok(started.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_una_consulta_de_lectura() {
        let flux = r#"from(bucket:"planta") |> range(start:-1h) |> filter(fn:(r) => r._measurement == "presion") |> last()"#;
        assert!(is_read_only(flux).is_ok());
    }

    #[test]
    fn rechaza_escritura() {
        let flux = r#"from(bucket:"a") |> range(start:-1h) |> to(bucket:"b")"#;
        assert!(is_read_only(flux).is_err());
    }

    #[test]
    fn rechaza_escritura_con_espacio_antes_del_parentesis() {
        // Un filtro que sólo busque «to(» se esquiva escribiendo «to (».
        let flux = r#"from(bucket:"a") |> to ("b")"#;
        assert!(is_read_only(flux).is_err());
    }

    #[test]
    fn rechaza_mayusculas() {
        assert!(is_read_only("DELETE(start: 2020-01-01T00:00:00Z)").is_err());
    }

    #[test]
    fn rechaza_salida_de_red() {
        // No escribe en la base, pero saca los datos del perímetro.
        assert!(is_read_only(r#"http.post(url: "https://ejemplo", data: bytes(v: "x"))"#).is_err());
    }
}
