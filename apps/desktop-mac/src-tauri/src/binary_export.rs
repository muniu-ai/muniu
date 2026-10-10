// SPDX-License-Identifier: Apache-2.0
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const MAX_BYTES: usize = 20 * 1024 * 1024;
#[derive(Default)]
pub struct ExportTickets { entries: HashMap<String, ExportTicket> }
pub struct ExportTicket { path: PathBuf, media_type: String, digest: String, byte_length: usize, expires_at: Instant }
pub fn validate_metadata(file_name: &str, media_type: &str, digest: &str, byte_length: usize) -> Result<(), String> {
    validate_name(file_name, media_type)?;
    if byte_length == 0 || byte_length > MAX_BYTES || digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {return Err("成果元数据无效".into());}
    Ok(())
}
impl ExportTickets {
    pub fn issue(&mut self, path: PathBuf, media_type: String, digest: String, byte_length: usize, now: Instant) -> Result<String, String> {
        self.entries.retain(|_, ticket| ticket.expires_at > now);
        if self.entries.len() >= 32 || !path.is_absolute() {return Err("保存凭据不可用，请关闭旧对话框后重试".into());}
        validate_metadata(path.file_name().and_then(|s| s.to_str()).ok_or("文件名无效")?, &media_type, &digest, byte_length)?;
        let mut nonce = [0u8;32]; getrandom::fill(&mut nonce).map_err(|_|"保存凭据创建失败".to_string())?;
        let token = nonce.iter().map(|b|format!("{b:02x}")).collect::<String>();
        self.entries.insert(token.clone(), ExportTicket {path,media_type,digest,byte_length,expires_at:now + Duration::from_secs(120)}); Ok(token)
    }
    pub fn discard(&mut self, token: &str) { self.entries.remove(token); }
    pub fn take(&mut self, token: &str, now: Instant) -> Result<ExportTicket,String> {
        let ticket = self.entries.remove(token).ok_or("保存凭据已失效，请重新选择位置")?;
        if ticket.expires_at <= now {return Err("保存凭据已过期，请重新选择位置".into());} Ok(ticket)
    }
}
impl ExportTicket {
    pub fn commit(self, content_base64: &str) -> Result<(),String> {
        let name=self.path.file_name().and_then(|s|s.to_str()).ok_or("文件名无效")?;
        let bytes=decode_export(name,&self.media_type,content_base64,&self.digest)?;
        if bytes.len()!=self.byte_length {return Err("成果文件大小不符".into());}
        write_export(&self.path,&self.media_type,&bytes)
    }
}

pub fn extension(media_type: &str) -> Result<&'static str, String> {
    match media_type {
        "application/pdf" => Ok("pdf"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Ok("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Ok("xlsx"),
        _ => Err("成果格式不受支持".to_string()),
    }
}
fn validate_name(name: &str, media_type: &str) -> Result<(), String> {
    let suffix = format!(".{}", extension(media_type)?);
    if name.is_empty() || name.len() > 240 || name.starts_with('.') || !name.ends_with(&suffix)
        || name.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c)) {
        return Err("请使用不含路径且格式正确的文件名".to_string());
    }
    Ok(())
}
fn validate_bytes(media_type: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err("成果为空或超过 20 MiB".to_string()); }
    let header: &[u8] = if extension(media_type)? == "pdf" { b"%PDF-" } else { b"PK\x03\x04" };
    if !bytes.starts_with(header) { return Err("成果内容与格式不符".to_string()); }
    Ok(())
}
pub fn decode_export(file_name: &str, media_type: &str, content_base64: &str, content_sha256: &str) -> Result<Vec<u8>, String> {
    validate_name(file_name, media_type)?;
    if content_base64.len() > MAX_BYTES.div_ceil(3) * 4 { return Err("成果超过 20 MiB".to_string()); }
    let bytes = STANDARD.decode(content_base64).map_err(|_| "成果编码无效".to_string())?;
    validate_bytes(media_type, &bytes)?;
    if format!("{:x}", Sha256::digest(&bytes)) != content_sha256 { return Err("成果内容摘要不符".to_string()); }
    Ok(bytes)
}
pub fn write_export(path: &Path, media_type: &str, bytes: &[u8]) -> Result<(), String> {
    if !path.is_absolute() { return Err("保存位置必须是绝对路径".to_string()); }
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("文件名无效")?;
    validate_name(name, media_type)?;
    validate_bytes(media_type, bytes)?;
    let mut options = OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|_| "文件已存在或目录不可写，请选择新的文件名".to_string())?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        return Err(if fs::remove_file(path).is_ok() { "成果写入失败，本次未完成的文件已清理" } else { "成果写入失败，请检查本次未完成的文件" }.to_string());
    }
    fs::File::open(path.parent().ok_or("保存目录无效")?).and_then(|directory| directory.sync_all())
        .map_err(|_| "文件已写入，但目录同步失败，请核对文件".to_string())
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    const PDF: &[u8] = b"%PDF-1.7\nSynthetic output\n%%EOF";

    fn decode(name: &str, mime: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
        super::decode_export(name, mime, &STANDARD.encode(bytes), &format!("{:x}", Sha256::digest(bytes)))
    }
    #[test]
    fn binary_export_tickets_are_single_use_expire_and_discard_without_writing() {
        use std::time::{Duration, Instant};
        let mut tickets = super::ExportTickets::default();
        let now = Instant::now();
        let path = std::env::temp_dir().join(format!("mn-ticket-{}.pdf", std::process::id()));
        let digest = format!("{:x}", Sha256::digest(PDF));
        let token = tickets.issue(path.clone(), "application/pdf".into(), digest.clone(), PDF.len(), now).unwrap();
        assert_eq!(token.len(), 64); assert!(!token.contains('/')); assert!(!path.exists());
        tickets.discard(&token); assert!(tickets.take(&token, now).is_err());
        let expired = tickets.issue(path.clone(), "application/pdf".into(), digest.clone(), PDF.len(), now).unwrap();
        assert!(tickets.take(&expired, now + Duration::from_secs(121)).is_err());
        let valid = tickets.issue(path.clone(), "application/pdf".into(), digest, PDF.len(), now).unwrap();
        let ticket = tickets.take(&valid, now).unwrap(); assert_eq!(ticket.path, path);
        assert!(tickets.take(&valid, now).is_err()); assert!(!path.exists());
        assert!(ticket.commit(&STANDARD.encode(b"%PDF-wrong")).is_err()); assert!(!path.exists());
    }
    #[test]
    fn binary_export_accepts_verified_pdf_and_ooxml_bytes() {
        assert_eq!(decode("成果.pdf", "application/pdf", PDF).unwrap(), PDF);
        for (extension, mime) in [("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] {
            assert_eq!(decode(&format!("成果.{extension}"), mime, b"PK\x03\x04synthetic").unwrap(), b"PK\x03\x04synthetic");
        }
    }
    #[test]
    fn binary_export_rejects_unverified_content_names_and_limits() {
        for name in ["../成果.pdf", "/tmp/成果.pdf", "bad\nname.pdf", ".hidden.pdf", "成果.sh"] {
            assert!(decode(name, "application/pdf", PDF).is_err());
        }
        assert!(decode("成果.pdf", "text/plain", PDF).is_err());
        assert!(decode("成果.pdf", "application/pdf", b"not a PDF").is_err());
        assert!(decode("成果.pdf", "application/pdf", b"").is_err());
        assert!(super::decode_export("成果.pdf", "application/pdf", "invalid base64", &"0".repeat(64)).is_err());
        assert!(super::decode_export("成果.pdf", "application/pdf", &STANDARD.encode(PDF), &"0".repeat(64)).is_err());
        assert!(super::decode_export("成果.pdf", "application/pdf", &"A".repeat(28 * 1024 * 1024), &"0".repeat(64)).is_err());
    }
    #[test]
    fn binary_export_never_overwrites_files_or_symlinks_and_uses_private_mode() {
        let directory = std::env::temp_dir().join(format!("mn-binary-export-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("成果.pdf");
        super::write_export(&path, "application/pdf", PDF).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(super::write_export(&path, "application/pdf", PDF).is_err());
        let link = directory.join("link.pdf"); symlink(&path, &link).unwrap();
        assert!(super::write_export(&link, "application/pdf", PDF).is_err());
        assert!(super::write_export(&directory.join("script.sh"), "application/pdf", PDF).is_err());
        assert!(super::write_export(std::path::Path::new("relative.pdf"), "application/pdf", PDF).is_err());
        assert_eq!(fs::read(&path).unwrap(), PDF);
        fs::remove_dir_all(directory).unwrap();
    }
}
