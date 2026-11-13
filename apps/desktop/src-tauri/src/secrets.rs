//! Almacén de credenciales del sistema operativo.
//!
//! El token de lectura de InfluxDB no vive en el proyecto, ni en la
//! configuración de la aplicación, ni en la memoria de la vista web. Vive en
//! el Administrador de credenciales de Windows (o el equivalente de cada
//! sistema) y sólo lo lee este proceso cuando va a hacer una consulta.
//!
//! De ahí la asimetría deliberada de esta API: hay `set`, `exists` y `delete`
//! expuestos a la interfaz, pero **no** hay `get`. La vista web puede decir
//! «guarda este token» y «¿hay token?», nunca «dame el token». Un `get`
//! expuesto convertiría cualquier registro de errores, volcado de memoria o
//! exportación del proyecto en una posible fuga de la credencial.

use keyring::Entry;
use serde::Serialize;

/// Servicio con el que se registran las credenciales en el almacén.
const SERVICE: &str = "INDUSTRIAL TWINS 360";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("La clave del secreto admite letras, dígitos y . _ - (recibido: {0:?})")]
    InvalidKey(String),
    #[error("El almacén de credenciales del sistema no está disponible: {0}")]
    Store(String),
}

// Tauri necesita serializar el error para devolverlo a la vista web. Se
// serializa sólo el mensaje: nunca el valor del secreto ni la ruta del
// almacén.
impl Serialize for SecretError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Valida la clave antes de tocar el almacén.
///
/// La clave llega de la vista web y acaba formando parte de un identificador
/// del almacén de credenciales del sistema. Restringir el alfabeto evita que
/// una clave con separadores o caracteres de control se interprete como otra
/// entrada distinta de la pretendida.
fn validate(key_id: &str) -> Result<(), SecretError> {
    let valid = !key_id.is_empty()
        && key_id.len() <= 120
        && key_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');

    if valid {
        Ok(())
    } else {
        Err(SecretError::InvalidKey(key_id.to_string()))
    }
}

fn entry(key_id: &str) -> Result<Entry, SecretError> {
    validate(key_id)?;
    Entry::new(SERVICE, key_id).map_err(|e| SecretError::Store(e.to_string()))
}

/// Guarda o reemplaza un secreto.
#[tauri::command]
pub fn secret_set(key_id: String, value: String) -> Result<(), SecretError> {
    let entry = entry(&key_id)?;
    entry
        .set_password(&value)
        .map_err(|e| SecretError::Store(e.to_string()))
}

/// Indica si hay un secreto guardado para la clave, sin devolverlo.
#[tauri::command]
pub fn secret_exists(key_id: String) -> Result<bool, SecretError> {
    let entry = entry(&key_id)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(SecretError::Store(e.to_string())),
    }
}

/// Borra el secreto. Borrar algo que no existe no es un error.
#[tauri::command]
pub fn secret_delete(key_id: String) -> Result<(), SecretError> {
    let entry = entry(&key_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::Store(e.to_string())),
    }
}

/// Lee el secreto. **Sólo para uso interno del proceso Rust.**
///
/// No está expuesto como comando de Tauri y no debe estarlo: es la función que
/// usa el proxy de telemetría para construir la cabecera de autorización, y su
/// resultado no cruza nunca hacia la vista web.
pub(crate) fn read_secret(key_id: &str) -> Result<String, SecretError> {
    let entry = entry(key_id)?;
    entry
        .get_password()
        .map_err(|e| SecretError::Store(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechaza_claves_con_separadores() {
        // Una clave con barra podría designar otra entrada del almacén.
        assert!(validate("influx/produccion").is_err());
        assert!(validate("influx\\produccion").is_err());
        assert!(validate("").is_err());
        assert!(validate(&"a".repeat(121)).is_err());
    }

    #[test]
    fn acepta_claves_razonables() {
        assert!(validate("influx-lectura").is_ok());
        assert!(validate("planta_norte.influx").is_ok());
        assert!(validate("TOKEN2").is_ok());
    }
}
