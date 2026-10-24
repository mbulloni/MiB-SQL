-- MiB-SQL demo database: a small shop with every object type the explorer shows.
DROP DATABASE IF EXISTS mibsql_demo;
CREATE DATABASE mibsql_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mibsql_demo;

CREATE TABLE customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  city VARCHAR(80),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Data registrazione'
) COMMENT 'Clienti';

CREATE TABLE products (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku CHAR(8) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  attributes JSON,
  KEY ix_products_name (name)
);

CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_id INT UNSIGNED NOT NULL,
  ordered_at DATETIME NOT NULL,
  status ENUM('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  KEY ix_orders_date (ordered_at, status)
);

CREATE TABLE order_items (
  order_id BIGINT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  qty SMALLINT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  happened_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  message TEXT,
  payload BLOB
);

INSERT INTO customers (name, email, city, created_at)
SELECT CONCAT('Cliente ', seq), CONCAT('cliente', seq, '@example.com'),
       ELT(1 + seq % 6, 'Roma', 'Milano', 'Napoli', 'Torino', 'Bologna', NULL),
       '2025-01-01' + INTERVAL seq HOUR
FROM seq_1_to_500;

INSERT INTO products (sku, name, price, stock, attributes)
SELECT LPAD(seq, 8, 'P0'), CONCAT('Prodotto ', seq), ROUND(5 + (seq * 7.31) % 400, 2), seq % 90,
       JSON_OBJECT('colore', ELT(1 + seq % 4, 'rosso', 'verde', 'blu', 'nero'), 'peso_g', seq * 13)
FROM seq_1_to_120;

INSERT INTO orders (customer_id, ordered_at, status)
SELECT 1 + (seq * 37) % 500, '2025-03-01' + INTERVAL (seq * 53) MINUTE, ELT(1 + seq % 4, 'new', 'paid', 'shipped', 'cancelled')
FROM seq_1_to_20000;

INSERT INTO order_items (order_id, product_id, qty, unit_price)
SELECT o.id, 1 + (o.id * k.seq * 11) % 120, 1 + (o.id + k.seq) % 5, p.price
FROM orders o JOIN seq_1_to_3 k ON k.seq <= 1 + o.id % 3
JOIN products p ON p.id = 1 + (o.id * k.seq * 11) % 120;

UPDATE orders o SET total = (SELECT SUM(qty * unit_price) FROM order_items i WHERE i.order_id = o.id);

INSERT INTO audit_log (message, payload) VALUES ('Database demo creato', UNHEX('DEADBEEF0001'));

CREATE VIEW v_customer_sales AS
SELECT c.id, c.name, c.city, COUNT(o.id) AS orders, SUM(o.total) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
GROUP BY c.id, c.name, c.city;

DELIMITER $$
CREATE FUNCTION fn_vat(amount DECIMAL(12,2)) RETURNS DECIMAL(12,2) DETERMINISTIC
BEGIN
  RETURN ROUND(amount * 1.22, 2);
END$$

CREATE PROCEDURE sp_top_customers(IN how_many INT)
BEGIN
  SELECT * FROM v_customer_sales ORDER BY revenue DESC LIMIT how_many;
  SELECT COUNT(*) AS total_customers FROM customers;
END$$

CREATE TRIGGER trg_orders_cancel AFTER UPDATE ON orders FOR EACH ROW
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    INSERT INTO audit_log (message) VALUES (CONCAT('Ordine annullato ', NEW.id));
  END IF;
END$$
DELIMITER ;

CREATE EVENT ev_purge_audit ON SCHEDULE EVERY 1 DAY DISABLE
DO DELETE FROM audit_log WHERE happened_at < NOW() - INTERVAL 90 DAY;

-- Test account limited to the demo database: MiB-SQL can be tried without touching anything else.
CREATE OR REPLACE USER 'mibsql'@'localhost' IDENTIFIED BY 'mibsql';
CREATE OR REPLACE USER 'mibsql'@'127.0.0.1' IDENTIFIED BY 'mibsql';
GRANT ALL PRIVILEGES ON mibsql_demo.* TO 'mibsql'@'localhost';
GRANT ALL PRIVILEGES ON mibsql_demo.* TO 'mibsql'@'127.0.0.1';
